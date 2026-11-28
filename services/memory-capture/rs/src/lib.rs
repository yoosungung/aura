//! memory_capture — PG forbidden · candidates envelope (Phase 4).

use aura_envelope::{Envelope, EnvelopeError};
use serde_json::{json, Value};

pub const TASK_SUBJECT: &str = "aura.tasks.memory.capture";
pub const CANDIDATES_SUBJECT: &str = "aura.events.memory.candidates";
pub const ERROR_SUBJECT: &str = "aura.events.memory.capture.error";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CaptureError {
    #[error("envelope: {0}")]
    Envelope(#[from] EnvelopeError),
    #[error("text_required")]
    TextRequired,
    #[error("tenant_id_required")]
    TenantIdRequired,
}

/// Heuristic: prefer short_term for short utterances; episodic for longer narrative.
pub fn extract_candidates(text: &str) -> Vec<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let kind = if trimmed.chars().count() < 80 {
        "short_term"
    } else {
        "episodic"
    };
    vec![json!({
        "kind": kind,
        "text": trimmed,
        "confidence": 0.5
    })]
}

pub fn build_candidates_envelope(
    tenant_id: &str,
    candidates: Vec<Value>,
) -> Result<Envelope, CaptureError> {
    if tenant_id.trim().is_empty() {
        return Err(CaptureError::TenantIdRequired);
    }
    let env = Envelope::new(
        "memory.candidates",
        tenant_id,
        json!({ "candidates": candidates }),
    );
    env.validate()?;
    Ok(env)
}

pub fn handle_capture(tenant_id: &str, text: &str) -> Result<Envelope, CaptureError> {
    if text.trim().is_empty() {
        return Err(CaptureError::TextRequired);
    }
    let candidates = extract_candidates(text);
    build_candidates_envelope(tenant_id, candidates)
}

#[cfg(test)]
mod parity_tests;
