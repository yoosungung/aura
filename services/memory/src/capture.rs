//! memory_capture — inline pipeline (extract → embed → store).
//! Live Gateway/PG sqlx wiring = canary follow-up; wire envelopes match Deployment.

use aura_envelope::{Envelope, EnvelopeError};
use serde_json::{json, Value};
use std::str;

pub const TASK_SUBJECT: &str = "aura.tasks.memory.capture";
pub const DONE_SUBJECT: &str = "aura.events.memory.capture.done";
pub const ERROR_SUBJECT: &str = "aura.events.memory.capture.error";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CaptureError {
    #[error("envelope: {0}")]
    Envelope(#[from] EnvelopeError),
    #[error("text_required")]
    TextRequired,
    #[error("tenant_id_required")]
    TenantIdRequired,
    #[error("invalid_candidate_memory_type")]
    InvalidCandidateMemoryType,
}

/// Heuristic extract (Node `defaultExtractCandidates` parity: short_term default).
pub fn extract_candidates(text: &str) -> Vec<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    vec![json!({
        "memory_type": "short_term",
        "content": trimmed
    })]
}

pub fn extract_candidates_with_kind(text: &str, kind: Option<&str>) -> Vec<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let memory_type = if kind == Some("episodic") {
        "episodic"
    } else {
        "short_term"
    };
    vec![json!({
        "memory_type": memory_type,
        "content": trimmed
    })]
}

/// Plan embed step: short_term skipped; episodic accepted (Gateway dims checked at live wire).
pub fn plan_embed(memory_type: &str) -> Value {
    if memory_type == "short_term" {
        return json!({
            "status": "skipped_short_term",
            "memory_type": "short_term"
        });
    }
    json!({
        "status": "accepted",
        "memory_type": memory_type,
        "via": "llm_gateway"
    })
}

/// Plan store step after embed (store module owns PG INSERT/UPSERT).
pub fn plan_store(memory_type: &str) -> Value {
    crate::store::plan_store_status(memory_type)
}

pub fn build_capture_done_envelope(
    tenant_id: &str,
    candidates: Vec<Value>,
    embedded: Vec<Value>,
    stored: Vec<Value>,
) -> Result<Envelope, CaptureError> {
    if tenant_id.trim().is_empty() {
        return Err(CaptureError::TenantIdRequired);
    }
    for c in &candidates {
        let mt = c.get("memory_type").and_then(|v| v.as_str()).unwrap_or("");
        if mt != "short_term" && mt != "episodic" {
            return Err(CaptureError::InvalidCandidateMemoryType);
        }
    }
    let env = Envelope::new(
        "memory.capture.done",
        tenant_id,
        json!({
            "candidates": candidates,
            "embedded": embedded,
            "stored": stored
        }),
    );
    env.validate()?;
    Ok(env)
}

/// In-process sequential plan: extract → embed → store (no NATS hop).
pub fn handle_capture(tenant_id: &str, text: &str) -> Result<Envelope, CaptureError> {
    handle_capture_with_kind(tenant_id, text, None)
}

pub fn handle_capture_with_kind(
    tenant_id: &str,
    text: &str,
    kind: Option<&str>,
) -> Result<Envelope, CaptureError> {
    if text.trim().is_empty() {
        return Err(CaptureError::TextRequired);
    }
    let candidates = extract_candidates_with_kind(text, kind);
    let mut embedded = Vec::new();
    let mut stored = Vec::new();
    for c in &candidates {
        let mt = c
            .get("memory_type")
            .and_then(|v| v.as_str())
            .ok_or(CaptureError::InvalidCandidateMemoryType)?;
        embedded.push(plan_embed(mt));
        stored.push(plan_store(mt));
    }
    build_capture_done_envelope(tenant_id, candidates, embedded, stored)
}

/// Parse JetStream / HTTP body → `(status, json body)`.
pub fn handle_capture_request(raw: &[u8]) -> Result<(u16, String), CaptureError> {
    let text = str::from_utf8(raw).unwrap_or("");
    let v: Value = if text.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(text).map_err(|_| CaptureError::TextRequired)?
    };
    let tenant_id = v
        .get("tenant_id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if tenant_id.is_empty() {
        return Err(CaptureError::TenantIdRequired);
    }
    let payload = v.get("payload").cloned().unwrap_or(json!({}));
    let kind = payload.get("kind").and_then(|x| x.as_str());
    let body_text = payload
        .get("text")
        .and_then(|x| x.as_str())
        .or_else(|| {
            payload
                .get("messages")
                .and_then(|m| m.as_array())
                .and_then(|arr| arr.last())
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
        })
        .unwrap_or("");
    let env = handle_capture_with_kind(&tenant_id, body_text, kind)?;
    let mut out = serde_json::to_value(&env).map_err(|_| CaptureError::TextRequired)?;
    if let Some(id) = v.get("id") {
        out["id"] = id.clone();
    }
    Ok((200, out.to_string()))
}
