//! Aura Gateway core (ARCHITECTURE §1 #13·#16 · §2.2) — wire parity with gateway.js.

mod rate_limit;

pub use rate_limit::*;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use uuid::Uuid;

pub const TASK_AGENT_INVOKE: &str = "aura.tasks.agent.invoke";
pub const STREAM_PREFIX: &str = "aura.stream.";
pub const STREAM_FRAME_TYPES: &[&str] = &[
    "run.started",
    "token",
    "tool.started",
    "tool.finished",
    "error",
    "run.completed",
];

#[cfg(test)]
mod parity_tests;

#[derive(Debug, Clone)]
pub struct Principal {
    pub id: String,
    pub tenant_id: String,
}

pub fn issue_run_id() -> String {
    Uuid::now_v7().to_string()
}

pub fn is_uuid_v7(id: &str) -> bool {
    match Uuid::parse_str(id) {
        Ok(u) => u.get_version() == Some(uuid::Version::SortRand),
        Err(_) => false,
    }
}

pub fn build_stream_subject(run_id: &str) -> Result<String, GatewayError> {
    if run_id.is_empty() {
        return Err(GatewayError::bad("run_id_required", 400));
    }
    if run_id.contains('*') || run_id.contains('>') || run_id.contains('.') {
        return Err(GatewayError::bad("run_id_invalid", 400));
    }
    Ok(format!("{STREAM_PREFIX}{run_id}"))
}

pub fn assert_exact_stream_subject(subject: &str, run_id: &str) -> Result<String, GatewayError> {
    if subject.contains('*') || subject.contains('>') {
        return Err(GatewayError::bad("stream_wildcard_forbidden", 400));
    }
    let expected = build_stream_subject(run_id)?;
    if subject != expected {
        return Err(GatewayError::bad("stream_subject_mismatch", 400));
    }
    Ok(expected)
}

pub fn validate_principal(principal: Option<&Principal>) -> Result<(), GatewayError> {
    let Some(p) = principal else {
        return Err(GatewayError::bad("principal_required", 401));
    };
    if p.id.is_empty() {
        return Err(GatewayError::bad("principal_id_required", 401));
    }
    if p.tenant_id.is_empty() {
        return Err(GatewayError::bad("principal_tenant_id_required", 401));
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct RunRecord {
    principal_id: String,
    tenant_id: String,
}

#[derive(Default)]
pub struct RunRegistry {
    runs: Mutex<HashMap<String, RunRecord>>,
}

impl RunRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, run_id: &str, principal: &Principal) -> Result<(), GatewayError> {
        validate_principal(Some(principal))?;
        if run_id.is_empty() {
            return Err(GatewayError::bad("run_id_required", 400));
        }
        self.runs.lock().unwrap().insert(
            run_id.to_string(),
            RunRecord {
                principal_id: principal.id.clone(),
                tenant_id: principal.tenant_id.clone(),
            },
        );
        Ok(())
    }

    pub fn authorize(&self, run_id: &str, principal: &Principal) -> Result<(), GatewayError> {
        validate_principal(Some(principal))?;
        let map = self.runs.lock().unwrap();
        let Some(owned) = map.get(run_id) else {
            return Err(GatewayError::bad("run_not_found", 404));
        };
        if owned.principal_id != principal.id {
            return Err(GatewayError::bad("principal_forbidden", 403));
        }
        if owned.tenant_id != principal.tenant_id {
            return Err(GatewayError::bad("tenant_forbidden", 403));
        }
        Ok(())
    }

    pub fn tenant_of(&self, run_id: &str) -> Option<String> {
        self.runs
            .lock()
            .unwrap()
            .get(run_id)
            .map(|r| r.tenant_id.clone())
    }
}

#[derive(Debug, Clone)]
pub struct GatewayError {
    pub message: String,
    pub status: u16,
    pub retry_after_ms: Option<u64>,
}

impl GatewayError {
    fn bad(msg: &str, status: u16) -> Self {
        Self {
            message: msg.into(),
            status,
            retry_after_ms: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SubmitResult {
    pub run_id: String,
    pub stream: bool,
    pub stream_subject: String,
    pub agent: String,
    pub version: String,
}

pub async fn submit_agent_invoke(
    body: &Value,
    principal: &Principal,
    registry: &RunRegistry,
    rate_limiter: &TenantRateLimiter,
    publish_task: impl FnOnce(String, Value) -> Result<(), String>,
) -> Result<SubmitResult, GatewayError> {
    validate_principal(Some(principal))?;
    let agent = body
        .get("agent")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| GatewayError::bad("agent_required", 400))?;
    let version = body
        .get("version")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| GatewayError::bad("version_required", 400))?;
    for forbidden in ["bundle", "bundle_uri", "cfg", "config", "secrets"] {
        if body.get(forbidden).is_some() {
            return Err(GatewayError::bad("identifiers_only", 400));
        }
    }

    let run_id = issue_run_id();
    if !is_uuid_v7(&run_id) {
        return Err(GatewayError::bad("run_id_not_uuidv7", 500));
    }

    rate_limiter
        .try_acquire(&principal.tenant_id, &run_id)
        .await
        .map_err(|e| GatewayError {
            message: e.error,
            status: e.status,
            retry_after_ms: Some(e.retry_after_ms),
        })?;

    registry.register(&run_id, principal)?;

    let stream = body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let task = json!({
        "run_id": run_id,
        "agent": agent,
        "version": version,
        "input": body.get("input").cloned().unwrap_or_else(|| json!({})),
        "session_id": body.get("session_id").cloned().unwrap_or(Value::Null),
        "stream": stream,
        "runtime": "nodejs",
        "principal": { "id": principal.id, "tenant_id": principal.tenant_id },
    });

    if let Err(e) = publish_task(TASK_AGENT_INVOKE.to_string(), task) {
        rate_limiter.release(&principal.tenant_id, &run_id).await;
        return Err(GatewayError::bad(&e, 500));
    }

    Ok(SubmitResult {
        run_id: run_id.clone(),
        stream,
        stream_subject: build_stream_subject(&run_id)?,
        agent: agent.to_string(),
        version: version.to_string(),
    })
}

pub async fn handle_submit_http(
    body: &Value,
    principal: &Principal,
    registry: &RunRegistry,
    rate_limiter: &TenantRateLimiter,
    publish_task: impl FnOnce(String, Value) -> Result<(), String>,
) -> (u16, Value) {
    match submit_agent_invoke(body, principal, registry, rate_limiter, publish_task).await {
        Ok(out) => (
            202,
            json!({
                "run_id": out.run_id,
                "stream": out.stream,
                "stream_subject": out.stream_subject,
                "agent": out.agent,
                "version": out.version,
            }),
        ),
        Err(e) => {
            let mut body = json!({ "error": e.message });
            if e.status == 429 {
                if let Some(ms) = e.retry_after_ms {
                    body["retry_after_ms"] = json!(ms);
                }
            }
            (e.status, body)
        }
    }
}

/// Collects stream frames during `open_stream_bridge` (injectable subscribe).
#[derive(Default)]
pub struct FrameSink {
    frames: Vec<Value>,
}

impl FrameSink {
    pub fn push(&mut self, frame: Value) {
        self.frames.push(frame);
    }

    fn into_frames(self) -> Vec<Value> {
        self.frames
    }
}

#[derive(Debug, Clone)]
pub struct StreamBridge {
    pub run_id: String,
    pub subject: String,
}

/// Authorize principal → exact `aura.stream.<run_id>` → deliver frames via `subscribe`.
/// On terminal frame, optionally `release` inflight (Node openStreamBridge parity).
pub async fn open_stream_bridge(
    run_id: &str,
    principal: &Principal,
    registry: &RunRegistry,
    rate_limiter: Option<&TenantRateLimiter>,
    subscribe: impl FnOnce(String, &mut FrameSink),
) -> Result<(StreamBridge, Vec<Value>), GatewayError> {
    registry.authorize(run_id, principal)?;
    let subject = assert_exact_stream_subject(&build_stream_subject(run_id)?, run_id)?;
    let tenant_id = registry.tenant_of(run_id);
    let mut sink = FrameSink::default();
    subscribe(subject.clone(), &mut sink);
    let frames = sink.into_frames();

    if let (Some(rl), Some(tid)) = (rate_limiter, tenant_id) {
        let mut released = false;
        for frame in &frames {
            if !released && is_terminal_stream_frame(frame) {
                rl.release(&tid, run_id).await;
                released = true;
            }
        }
    }

    Ok((
        StreamBridge {
            run_id: run_id.to_string(),
            subject,
        },
        frames,
    ))
}

pub fn authorize_ws(
    run_id: &str,
    principal: &Principal,
    registry: &RunRegistry,
) -> Result<String, GatewayError> {
    registry.authorize(run_id, principal)?;
    assert_exact_stream_subject(&build_stream_subject(run_id)?, run_id)
}

pub fn format_sse_frame(frame: &Value) -> String {
    let payload = serde_json::to_string(frame).unwrap_or_else(|_| "{}".into());
    format!("data: {payload}\n\n")
}

#[derive(Debug)]
pub struct SseHttpResult {
    pub status: u16,
    pub content_type: &'static str,
    pub frames: Vec<String>,
    pub body: Option<Value>,
}

pub async fn handle_sse_http(
    run_id: &str,
    principal: &Principal,
    registry: &RunRegistry,
    rate_limiter: Option<&TenantRateLimiter>,
    subscribe: impl FnOnce(String, &mut FrameSink),
) -> SseHttpResult {
    match open_stream_bridge(run_id, principal, registry, rate_limiter, subscribe).await {
        Ok((_bridge, frames)) => SseHttpResult {
            status: 200,
            content_type: "text/event-stream",
            frames: frames.iter().map(format_sse_frame).collect(),
            body: None,
        },
        Err(e) => SseHttpResult {
            status: e.status,
            content_type: "application/json",
            frames: vec![],
            body: Some(json!({ "error": e.message })),
        },
    }
}

pub async fn release_inflight_from_event(
    subject: &str,
    tenant_id: &str,
    run_id: &str,
    rate_limiter: &TenantRateLimiter,
) -> (bool, bool) {
    if !is_terminal_invoke_event(subject) {
        return (true, false);
    }
    rate_limiter.release(tenant_id, run_id).await
}
