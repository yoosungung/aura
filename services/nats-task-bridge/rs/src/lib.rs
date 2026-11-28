//! JetStream → Fission Router task bridge (ARCHITECTURE §4.1).
//! Wire-parity with `bridge.js` — agent/mcp async only, no domain handlers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::{Mutex, Notify};

pub const DEFAULT_FETCH_TIMEOUT_MS: u64 = 110_000;
pub const DEFAULT_MAX_INFLIGHT: usize = 32;
pub const DEFAULT_WORKING_INTERVAL_MS: u64 = 10_000;
pub const DEFAULT_MAX_DELIVER: i64 = 5;
pub const DEFAULT_RUNTIME: &str = "nodejs";
pub const DEFAULT_ROUTER_URL: &str = "http://router-internal.fission.svc:8889";
pub const DEFAULT_STREAM: &str = "AURA_TASKS";

pub fn desired_ack_wait_ms(fetch_timeout_ms: u64) -> u64 {
    let fetch = if fetch_timeout_ms > 0 {
        fetch_timeout_ms
    } else {
        110_000
    };
    fetch + 40_000
}

pub const DEFAULT_ACK_WAIT_MS: u64 = 110_000 + 40_000;

#[derive(Debug, Clone)]
pub struct TaskRoute {
    pub nodejs: &'static str,
    pub python: &'static str,
    pub resp_topic: &'static str,
    pub error_topic: &'static str,
}

pub fn task_routes() -> HashMap<&'static str, TaskRoute> {
    HashMap::from([
        (
            "aura.tasks.agent.invoke",
            TaskRoute {
                nodejs: "aura-agent-invoke",
                python: "aura-agent-invoke-py",
                resp_topic: "aura.events.agent.invoke.done",
                error_topic: "aura.events.agent.invoke.error",
            },
        ),
        (
            "aura.tasks.mcp.invoke",
            TaskRoute {
                nodejs: "aura-mcp-invoke",
                python: "aura-mcp-invoke-py",
                resp_topic: "aura.events.mcp.invoke.done",
                error_topic: "aura.events.mcp.invoke.error",
            },
        ),
    ])
}

pub fn task_subjects() -> Vec<&'static str> {
    let mut keys: Vec<_> = task_routes().keys().copied().collect();
    keys.sort_unstable();
    keys
}

fn custom_prefix(subject: &str) -> Option<&'static str> {
    match subject {
        "aura.tasks.agent.invoke" => Some("aura-agent-invoke-"),
        "aura.tasks.mcp.invoke" => Some("aura-mcp-invoke-"),
        _ => None,
    }
}

fn allowed_custom_function(subject: &str, function_name: &str) -> Option<String> {
    let prefix = custom_prefix(subject)?;
    if function_name.len() > 63 || function_name.len() <= prefix.len() {
        return None;
    }
    if !function_name.starts_with(prefix) {
        return None;
    }
    if subject == "aura.tasks.mcp.invoke" && function_name.starts_with("aura-mcp-invoke-rpc-") {
        return None;
    }
    if matches!(
        function_name,
        "aura-agent-invoke-py" | "aura-mcp-invoke-py"
    ) {
        return None;
    }
    let rest = &function_name[prefix.len()..];
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

pub fn parse_runtime(payload: &str) -> String {
    let obj: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    obj.get("runtime")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_RUNTIME)
        .to_string()
}

pub fn parse_function_name(payload: &str) -> String {
    let obj: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    obj.get("function")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

pub fn function_for_task(
    subject: &str,
    runtime: Option<&str>,
    function_name: Option<&str>,
) -> Option<String> {
    let routes = task_routes();
    let route = routes.get(subject)?;
    let rt = runtime.unwrap_or(DEFAULT_RUNTIME);
    if rt == "custom" {
        return allowed_custom_function(subject, function_name.unwrap_or(""));
    }
    Some(match rt {
        "python" => route.python.to_string(),
        _ => route.nodejs.to_string(),
    })
}

pub fn topics_for_task(subject: &str) -> Option<(String, String)> {
    task_routes()
        .get(subject)
        .map(|r| (r.resp_topic.to_string(), r.error_topic.to_string()))
}

pub fn router_base(router_url: Option<&str>) -> String {
    let raw = router_url
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_ROUTER_URL);
    raw.trim_end_matches('/').to_string()
}

pub fn ms_to_nanos(ms: u64) -> i64 {
    (ms.max(1) as i64).saturating_mul(1_000_000)
}

#[derive(Debug, Clone)]
pub struct ConsumerConfigParity {
    pub durable_name: String,
    pub filter_subject: String,
    pub ack_wait_ns: i64,
    pub max_deliver: i64,
}

pub fn ensure_task_consumer_config(
    subject: &str,
    durable: &str,
    ack_wait_ms: u64,
    max_deliver: i64,
) -> ConsumerConfigParity {
    ConsumerConfigParity {
        durable_name: durable.into(),
        filter_subject: subject.into(),
        ack_wait_ns: ms_to_nanos(ack_wait_ms),
        max_deliver,
    }
}

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
    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .timeout(Duration::from_millis(fetch_timeout_ms.max(1)))
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(InvokeResult { status, body })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckDisposition {
    Ack,
    Nak,
}

#[derive(Debug)]
pub struct HandleOutcome {
    pub ok: bool,
    pub error: Option<String>,
    pub function: Option<String>,
    pub status: Option<u16>,
    pub disposition: AckDisposition,
    pub publishes: Vec<(String, Value)>,
}

pub async fn handle_task_message<F, Fut>(subject: &str, data: &[u8], invoke: F) -> HandleOutcome
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = Result<InvokeResult, String>>,
{
    let payload = {
        let s = String::from_utf8_lossy(data).to_string();
        if s.is_empty() {
            "{}".into()
        } else {
            s
        }
    };
    let runtime = parse_runtime(&payload);
    let fn_parsed = parse_function_name(&payload);
    let topics = topics_for_task(subject);
    let mapped = function_for_task(subject, Some(&runtime), Some(&fn_parsed));

    if mapped.is_none() || topics.is_none() {
        let error = if topics.is_some() {
            "function_not_allowed"
        } else {
            "unknown_task_subject"
        };
        let err_topic = topics
            .as_ref()
            .map(|(_, e)| e.clone())
            .unwrap_or_else(|| "aura.events.agent.invoke.error".into());
        return HandleOutcome {
            ok: false,
            error: Some(error.into()),
            function: None,
            status: None,
            disposition: AckDisposition::Ack,
            publishes: vec![(
                err_topic,
                json!({
                    "ok": false,
                    "error": error,
                    "subject": if subject.is_empty() { Value::Null } else { json!(subject) },
                }),
            )],
        };
    }

    let fn_name = mapped.unwrap();
    let (resp_topic, error_topic) = topics.unwrap();

    match invoke(fn_name.clone(), payload).await {
        Ok(out) => {
            let body_obj: Value = serde_json::from_str(&out.body).unwrap_or_else(|_| {
                json!({
                    "ok": false,
                    "error": "invalid_function_json",
                    "raw": out.body,
                })
            });
            let publishes = if (200..300).contains(&out.status) {
                vec![(resp_topic, body_obj)]
            } else {
                vec![(
                    error_topic,
                    json!({
                        "ok": false,
                        "error": body_obj.get("error").cloned().unwrap_or_else(|| json!("function_error")),
                        "status": out.status,
                        "function": fn_name,
                        "body": body_obj,
                    }),
                )]
            };
            HandleOutcome {
                ok: true,
                error: None,
                function: Some(fn_name),
                status: Some(out.status),
                disposition: AckDisposition::Ack,
                publishes,
            }
        }
        Err(err) => HandleOutcome {
            ok: false,
            error: Some("fission_invoke_failed".into()),
            function: Some(fn_name.clone()),
            status: None,
            disposition: AckDisposition::Nak,
            publishes: vec![(
                error_topic,
                json!({
                    "ok": false,
                    "error": "fission_invoke_failed",
                    "detail": err,
                    "function": fn_name,
                    "subject": subject,
                }),
            )],
        },
    }
}

fn durable_for_subject(subject: &str) -> &'static str {
    match subject {
        "aura.tasks.agent.invoke" => "aura_task_bridge_agent",
        "aura.tasks.mcp.invoke" => "aura_task_bridge_mcp",
        _ => "aura_task_bridge",
    }
}

#[derive(Debug, Clone)]
pub struct TaskBridgeConfig {
    pub nats_url: String,
    pub router_url: String,
    pub stream: String,
    pub max_inflight: usize,
    pub fetch_timeout_ms: u64,
    pub ack_wait_ms: u64,
    pub max_deliver: i64,
    pub working_interval_ms: u64,
}

pub async fn run_task_bridge(cfg: TaskBridgeConfig) -> Result<(), String> {
    let opts = aura_nats::connect_options_insecure_for_lab();
    let client = aura_nats::connect(&cfg.nats_url, opts)
        .await
        .map_err(|e| e.to_string())?;
    let js = async_nats::jetstream::new(client.clone());
    let http = reqwest::Client::new();
    let gate = Arc::new(InflightGate::new(cfg.max_inflight));

    for subject in task_subjects() {
        let durable = durable_for_subject(subject);
        let consumer_cfg =
            ensure_task_consumer_config(subject, durable, cfg.ack_wait_ms, cfg.max_deliver);
        let stream_obj = js
            .get_stream(&cfg.stream)
            .await
            .map_err(|e| format!("stream {}: {e}", cfg.stream))?;
        let consumer = stream_obj
            .get_or_create_consumer(
                durable,
                async_nats::jetstream::consumer::pull::Config {
                    durable_name: Some(consumer_cfg.durable_name.clone()),
                    filter_subject: consumer_cfg.filter_subject.clone(),
                    ack_policy: async_nats::jetstream::consumer::AckPolicy::Explicit,
                    ack_wait: Duration::from_millis(cfg.ack_wait_ms),
                    max_deliver: consumer_cfg.max_deliver,
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;

        tracing::info!(
            subject,
            durable,
            max_inflight = gate.max(),
            ack_wait_ms = cfg.ack_wait_ms,
            "nats-task-bridge listen"
        );

        let mut messages = consumer.messages().await.map_err(|e| e.to_string())?;
        let client = client.clone();
        let http = http.clone();
        let router = cfg.router_url.clone();
        let gate = gate.clone();
        let fetch_timeout_ms = cfg.fetch_timeout_ms;
        let working_interval_ms = cfg.working_interval_ms;
        tokio::spawn(async move {
            while let Some(msg) = messages.next().await {
                let Ok(msg) = msg else { continue };
                let client = client.clone();
                let http = http.clone();
                let router = router.clone();
                let gate = gate.clone();
                tokio::spawn(async move {
                    gate.acquire().await;

                    let hb = {
                        let msg = msg.clone();
                        let interval = Duration::from_millis(working_interval_ms.max(1));
                        tokio::spawn(async move {
                            let mut tick = tokio::time::interval(interval);
                            loop {
                                tick.tick().await;
                                let _ = msg
                                    .ack_with(async_nats::jetstream::AckKind::Progress)
                                    .await;
                            }
                        })
                    };

                    let subject = msg.subject.clone();
                    let data = msg.payload.clone();
                    let outcome = handle_task_message(&subject, &data, |fn_name, payload| {
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
                    })
                    .await;

                    for (topic, body) in outcome.publishes {
                        let _ = client.publish(topic, Bytes::from(body.to_string())).await;
                    }
                    match outcome.disposition {
                        AckDisposition::Ack => {
                            let _ = msg.ack().await;
                        }
                        AckDisposition::Nak => {
                            let _ = msg
                                .ack_with(async_nats::jetstream::AckKind::Nak(None))
                                .await;
                        }
                    }
                    hb.abort();
                    gate.release().await;
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

    #[test]
    fn mapping_and_ack_wait_parity() {
        assert_eq!(
            task_subjects(),
            vec!["aura.tasks.agent.invoke", "aura.tasks.mcp.invoke"]
        );
        assert_eq!(
            function_for_task("aura.tasks.agent.invoke", Some("nodejs"), None).as_deref(),
            Some("aura-agent-invoke")
        );
        assert_eq!(
            function_for_task("aura.tasks.agent.invoke", Some("python"), None).as_deref(),
            Some("aura-agent-invoke-py")
        );
        assert_eq!(
            function_for_task("aura.tasks.mcp.invoke", Some("python"), None).as_deref(),
            Some("aura-mcp-invoke-py")
        );
        assert_eq!(
            function_for_task(
                "aura.tasks.agent.invoke",
                Some("custom"),
                Some("aura-agent-invoke-demo")
            )
            .as_deref(),
            Some("aura-agent-invoke-demo")
        );
        assert_eq!(
            function_for_task(
                "aura.tasks.mcp.invoke",
                Some("custom"),
                Some("aura-mcp-invoke-rpc-demo")
            ),
            None
        );
        assert_eq!(
            function_for_task(
                "aura.tasks.agent.invoke",
                Some("custom"),
                Some("aura-agent-invoke-py")
            ),
            None
        );
        assert_eq!(parse_runtime(r#"{"runtime":"python"}"#), "python");
        assert_eq!(parse_runtime("{}"), "nodejs");
        let (resp, _) = topics_for_task("aura.tasks.agent.invoke").unwrap();
        assert_eq!(resp, "aura.events.agent.invoke.done");
        assert_eq!(desired_ack_wait_ms(110_000), 150_000);
        assert_eq!(DEFAULT_ACK_WAIT_MS, 150_000);
        const _: () = assert!(DEFAULT_MAX_INFLIGHT >= 16 && DEFAULT_MAX_INFLIGHT <= 32);
        const _: () = assert!(DEFAULT_WORKING_INTERVAL_MS == 10_000);
        const _: () = assert!(DEFAULT_MAX_DELIVER == 5);
        let cfg = ensure_task_consumer_config(
            "aura.tasks.agent.invoke",
            "aura_task_bridge_agent",
            DEFAULT_ACK_WAIT_MS,
            DEFAULT_MAX_DELIVER,
        );
        assert_eq!(cfg.ack_wait_ns, ms_to_nanos(150_000));
        assert_eq!(cfg.max_deliver, 5);
    }

    #[tokio::test]
    async fn handle_publishes_done_on_2xx() {
        let out = handle_task_message(
            "aura.tasks.agent.invoke",
            br#"{"runtime":"python","run_id":"r1"}"#,
            |fn_name, _| async move {
                assert_eq!(fn_name, "aura-agent-invoke-py");
                Ok(InvokeResult {
                    status: 200,
                    body: r#"{"type":"agent.invoke.done","ok":true}"#.into(),
                })
            },
        )
        .await;
        assert!(out.ok);
        assert_eq!(out.disposition, AckDisposition::Ack);
        assert_eq!(out.publishes[0].0, "aura.events.agent.invoke.done");
    }

    #[tokio::test]
    async fn handle_naks_on_invoke_failure() {
        let out = handle_task_message(
            "aura.tasks.mcp.invoke",
            br#"{"runtime":"nodejs"}"#,
            |_f, _p| async { Err("boom".into()) },
        )
        .await;
        assert!(!out.ok);
        assert_eq!(out.disposition, AckDisposition::Nak);
        assert_eq!(out.publishes[0].0, "aura.events.mcp.invoke.error");
    }
}
