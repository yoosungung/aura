//! NATS Core RR → Fission Router bridge (ARCHITECTURE §3.3 · §4.2).
//! Wire-parity with `bridge.js` — no domain handlers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::{Mutex, Notify};

pub const QUEUE_GROUP: &str = "aura-rpc-bridge";
pub const DEFAULT_FETCH_TIMEOUT_MS: u64 = 25_000;
pub const DEFAULT_MAX_INFLIGHT: usize = 64;
pub const DEFAULT_ROUTER_URL: &str = "http://router-internal.fission.svc:8889";

const MCP_CUSTOM_PREFIX: &str = "aura-mcp-invoke-rpc-";

pub fn subject_to_function() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("aura.rpc.memory.recall", "aura-memory-recall"),
        ("aura.rpc.control.resolve", "aura-control-resolve"),
        ("aura.rpc.mcp.tool", "aura-mcp-invoke-rpc"),
    ])
}

pub fn subjects() -> Vec<&'static str> {
    let mut keys: Vec<_> = subject_to_function().keys().copied().collect();
    keys.sort_unstable();
    keys
}

fn mcp_tool_by_runtime(runtime: &str) -> &'static str {
    match runtime {
        "python" => "aura-mcp-invoke-rpc-py",
        _ => "aura-mcp-invoke-rpc",
    }
}

fn allowed_mcp_custom_function(function_name: &str) -> Option<String> {
    if function_name.len() > 63 || function_name.len() <= MCP_CUSTOM_PREFIX.len() {
        return None;
    }
    if !function_name.starts_with(MCP_CUSTOM_PREFIX) {
        return None;
    }
    if function_name == "aura-mcp-invoke-rpc-py" {
        return None;
    }
    let rest = &function_name[MCP_CUSTOM_PREFIX.len()..];
    let ok = !rest.is_empty()
        && !rest.starts_with('-')
        && !rest.ends_with('-')
        && rest.chars().enumerate().all(|(i, c)| match c {
            'a'..='z' | '0'..='9' => true,
            '-' => i > 0 && i + 1 < rest.len(),
            _ => false,
        });
    if ok {
        Some(function_name.to_string())
    } else {
        None
    }
}

pub fn parse_runtime_from_payload(payload: &str) -> String {
    let obj: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    obj.get("runtime")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("nodejs")
        .to_string()
}

pub fn parse_function_name(payload: &str) -> String {
    let obj: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    obj.get("function")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

pub fn function_for_subject(
    subject: &str,
    runtime: Option<&str>,
    function_name: Option<&str>,
) -> Option<String> {
    if subject == "aura.rpc.mcp.tool" {
        let rt = runtime.unwrap_or("nodejs");
        if rt == "custom" {
            return allowed_mcp_custom_function(function_name.unwrap_or(""));
        }
        return Some(mcp_tool_by_runtime(rt).to_string());
    }
    subject_to_function()
        .get(subject)
        .map(|s| (*s).to_string())
}

pub fn router_base(router_url: Option<&str>) -> String {
    let raw = router_url
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_ROUTER_URL);
    raw.trim_end_matches('/').to_string()
}

/// Semaphore-style in-flight gate (Node createInflightGate parity).
#[derive(Debug)]
pub struct InflightGate {
    max: usize,
    active: AtomicUsize,
    waiters: Mutex<Vec<Arc<Notify>>>,
}

impl InflightGate {
    pub fn new(max: usize) -> Self {
        Self {
            max: max.max(1),
            active: AtomicUsize::new(0),
            waiters: Mutex::new(Vec::new()),
        }
    }

    pub fn max(&self) -> usize {
        self.max
    }

    pub fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }

    pub async fn acquire(&self) {
        loop {
            let cur = self.active.load(Ordering::SeqCst);
            if cur < self.max {
                if self
                    .active
                    .compare_exchange(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    return;
                }
                continue;
            }
            let n = Arc::new(Notify::new());
            self.waiters.lock().await.push(n.clone());
            n.notified().await;
        }
    }

    pub async fn release(&self) {
        let prev = self.active.fetch_sub(1, Ordering::SeqCst);
        if prev == 0 {
            self.active.store(0, Ordering::SeqCst);
        }
        let next = {
            let mut w = self.waiters.lock().await;
            if w.is_empty() {
                None
            } else {
                Some(w.remove(0))
            }
        };
        if let Some(n) = next {
            n.notify_one();
        }
    }
}

#[derive(Debug, Clone)]
pub struct InvokeResult {
    pub status: u16,
    pub body: String,
}

pub async fn invoke_fission(
    function_name: &str,
    payload: &str,
    router_url: Option<&str>,
    fetch_timeout_ms: u64,
    client: &reqwest::Client,
) -> Result<InvokeResult, String> {
    let url = format!(
        "{}/fission-function/{}",
        router_base(router_url),
        function_name
    );
    let timeout = Duration::from_millis(fetch_timeout_ms.max(1));
    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .timeout(timeout)
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(InvokeResult { status, body })
}

#[derive(Debug)]
pub struct HandleResult {
    pub status: u16,
    pub body: String,
    pub function: Option<String>,
}

pub async fn handle_nats_message<F, Fut>(
    subject: &str,
    data: &[u8],
    mut respond: impl FnMut(Bytes),
    invoke: F,
) -> HandleResult
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = Result<InvokeResult, String>>,
{
    let payload = String::from_utf8_lossy(data).to_string();
    let payload = if payload.is_empty() {
        "{}".to_string()
    } else {
        payload
    };
    let runtime = parse_runtime_from_payload(&payload);
    let fn_name = parse_function_name(&payload);
    let mapped = function_for_subject(subject, Some(&runtime), Some(&fn_name));

    let (status, reply_body, function) = match mapped {
        None => {
            let map = subject_to_function();
            let err = if map.contains_key(subject) {
                "function_not_allowed"
            } else {
                "unknown_rpc_subject"
            };
            let body = serde_json::json!({
                "ok": false,
                "error": err,
                "subject": if subject.is_empty() { Value::Null } else { Value::String(subject.into()) },
            })
            .to_string();
            (404, body, None)
        }
        Some(fn_name) => match invoke(fn_name.clone(), payload).await {
            Ok(out) => {
                let mut body = out.body;
                if body.is_empty() {
                    body = serde_json::json!({
                        "ok": false,
                        "error": "empty_function_response",
                        "function": fn_name,
                        "status": out.status,
                    })
                    .to_string();
                }
                (out.status, body, Some(fn_name))
            }
            Err(err) => {
                let body = serde_json::json!({
                    "ok": false,
                    "error": "fission_invoke_failed",
                    "detail": err,
                    "function": fn_name,
                    "subject": subject,
                })
                .to_string();
                (502, body, Some(fn_name))
            }
        },
    };

    respond(Bytes::from(reply_body.clone()));
    HandleResult {
        status,
        body: reply_body,
        function,
    }
}

async fn dispatch_one(
    client: async_nats::Client,
    msg: async_nats::Message,
    http: reqwest::Client,
    router: String,
    fetch_timeout_ms: u64,
    gate: Arc<InflightGate>,
) {
    gate.acquire().await;
    let subject = msg.subject.clone();
    let data = msg.payload.clone();
    let reply = msg.reply.clone();
    let _ = handle_nats_message(
        &subject,
        &data,
        |bytes| {
            if let Some(reply_subject) = reply.clone() {
                let client = client.clone();
                tokio::spawn(async move {
                    let _ = client.publish(reply_subject, bytes).await;
                });
            }
        },
        |fn_name, payload| {
            let http = http.clone();
            let router = router.clone();
            async move {
                invoke_fission(
                    &fn_name,
                    &payload,
                    Some(&router),
                    fetch_timeout_ms,
                    &http,
                )
                .await
            }
        },
    )
    .await;
    gate.release().await;
}

/// Subscribe queue-group subjects and dispatch without HOL (await in loop forbidden).
pub async fn run_bridge(
    nats_url: &str,
    router_url: &str,
    queue: &str,
    max_inflight: usize,
    fetch_timeout_ms: u64,
) -> Result<(), String> {
    let opts = aura_nats::connect_options_insecure_for_lab();
    let client = aura_nats::connect(nats_url, opts)
        .await
        .map_err(|e| e.to_string())?;
    let http = reqwest::Client::new();
    let gate = Arc::new(InflightGate::new(max_inflight));

    for subject in subjects() {
        let mut sub = client
            .queue_subscribe(subject.to_string(), queue.to_string())
            .await
            .map_err(|e| e.to_string())?;
        tracing::info!(
            subject,
            queue,
            max_inflight = gate.max(),
            "nats-rpc-bridge listen"
        );
        let client = client.clone();
        let http = http.clone();
        let router = router_url.to_string();
        let gate = gate.clone();
        tokio::spawn(async move {
            while let Some(msg) = sub.next().await {
                let client = client.clone();
                let http = http.clone();
                let router = router.clone();
                let gate = gate.clone();
                // Do not await — parallel dispatch; gate caps concurrency.
                tokio::spawn(async move {
                    dispatch_one(client, msg, http, router, fetch_timeout_ms, gate).await;
                });
            }
        });
    }

    futures_util::future::pending::<()>().await;
    #[allow(unreachable_code)]
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    #[test]
    fn mapping_parity_with_node() {
        assert_eq!(QUEUE_GROUP, "aura-rpc-bridge");
        assert_eq!(
            function_for_subject("aura.rpc.memory.recall", None, None).as_deref(),
            Some("aura-memory-recall")
        );
        assert_eq!(
            function_for_subject("aura.rpc.control.resolve", None, None).as_deref(),
            Some("aura-control-resolve")
        );
        assert_eq!(
            function_for_subject("aura.rpc.mcp.tool", None, None).as_deref(),
            Some("aura-mcp-invoke-rpc")
        );
        assert_eq!(
            function_for_subject("aura.rpc.mcp.tool", Some("nodejs"), None).as_deref(),
            Some("aura-mcp-invoke-rpc")
        );
        assert_eq!(
            function_for_subject("aura.rpc.mcp.tool", Some("python"), None).as_deref(),
            Some("aura-mcp-invoke-rpc-py")
        );
        assert_eq!(
            function_for_subject(
                "aura.rpc.mcp.tool",
                Some("custom"),
                Some("aura-mcp-invoke-rpc-demo")
            )
            .as_deref(),
            Some("aura-mcp-invoke-rpc-demo")
        );
        assert_eq!(
            function_for_subject(
                "aura.rpc.mcp.tool",
                Some("custom"),
                Some("aura-mcp-invoke-rpc-py")
            ),
            None
        );
        assert_eq!(
            function_for_subject(
                "aura.rpc.mcp.tool",
                Some("custom"),
                Some("aura-mcp-invoke-demo")
            ),
            None
        );
        assert_eq!(
            function_for_subject(
                "aura.rpc.mcp.tool",
                Some("nodejs"),
                Some("aura-mcp-invoke-rpc-evil")
            )
            .as_deref(),
            Some("aura-mcp-invoke-rpc")
        );
        assert_eq!(
            function_for_subject(
                "aura.rpc.memory.recall",
                Some("custom"),
                Some("aura-mcp-invoke-rpc-demo")
            )
            .as_deref(),
            Some("aura-memory-recall")
        );
        assert_eq!(function_for_subject("aura.rpc.unknown", None, None), None);
        let mut keys: Vec<_> = subject_to_function().keys().copied().collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "aura.rpc.control.resolve",
                "aura.rpc.mcp.tool",
                "aura.rpc.memory.recall",
            ]
        );
        const _: () = assert!(DEFAULT_MAX_INFLIGHT >= 50 && DEFAULT_MAX_INFLIGHT <= 100);
        const _: () = assert!(DEFAULT_FETCH_TIMEOUT_MS >= 1000);
    }

    #[tokio::test]
    async fn handle_unknown_subject_404() {
        let replied = Arc::new(StdMutex::new(None));
        let r2 = replied.clone();
        let out = handle_nats_message(
            "aura.rpc.nope",
            b"{}",
            |b| *r2.lock().unwrap() = Some(b),
            |_f, _p| async {
                Ok(InvokeResult {
                    status: 200,
                    body: "{}".into(),
                })
            },
        )
        .await;
        assert_eq!(out.status, 404);
        assert!(out.body.contains("unknown_rpc_subject"));
        assert!(replied.lock().unwrap().is_some());
    }

    #[tokio::test]
    async fn handle_invokes_mapped_function() {
        let replied = Arc::new(StdMutex::new(None));
        let r2 = replied.clone();
        let out = handle_nats_message(
            "aura.rpc.memory.recall",
            br#"{"tenant_id":"t1","query":"hi"}"#,
            |b| *r2.lock().unwrap() = Some(b),
            |fn_name, payload| async move {
                assert_eq!(fn_name, "aura-memory-recall");
                assert!(payload.contains("tenant_id"));
                Ok(InvokeResult {
                    status: 200,
                    body: r#"{"type":"memory.recall.done","ok":true}"#.into(),
                })
            },
        )
        .await;
        assert_eq!(out.status, 200);
        assert_eq!(out.function.as_deref(), Some("aura-memory-recall"));
        assert!(out.body.contains("memory.recall.done"));
    }

    #[tokio::test]
    async fn custom_denied_returns_function_not_allowed() {
        let out = handle_nats_message(
            "aura.rpc.mcp.tool",
            br#"{"runtime":"custom","function":"aura-mcp-invoke-rpc-py"}"#,
            |_| {},
            |_f, _p| async {
                Ok(InvokeResult {
                    status: 200,
                    body: "{}".into(),
                })
            },
        )
        .await;
        assert_eq!(out.status, 404);
        assert!(out.body.contains("function_not_allowed"));
    }

    #[tokio::test]
    async fn inflight_gate_caps_concurrency() {
        let gate = Arc::new(InflightGate::new(2));
        gate.acquire().await;
        gate.acquire().await;
        assert_eq!(gate.active(), 2);
        let g = gate.clone();
        let third = tokio::spawn(async move {
            g.acquire().await;
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!third.is_finished());
        gate.release().await;
        third.await.unwrap();
        assert_eq!(gate.active(), 2);
        gate.release().await;
        gate.release().await;
        assert_eq!(gate.active(), 0);
    }
}
