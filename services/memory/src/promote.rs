//! consolidate type-promotion rules (ARCHITECTURE §5 · Node promote.js parity).

use serde_json::{json, Value};
use std::collections::HashSet;

fn allowed_transitions() -> HashSet<&'static str> {
    HashSet::from([
        "short_term->episodic",
        "episodic->long_term",
        "episodic->semantic",
    ])
}

fn valid_reasons() -> HashSet<&'static str> {
    HashSet::from(["session_boundary", "recurrence", "llm_extract", "operator"])
}

pub const RECURRENCE_MIN_EVIDENCE: i64 = 3;

pub fn is_allowed_transition(from_type: &str, to_type: &str) -> bool {
    allowed_transitions().contains(format!("{from_type}->{to_type}").as_str())
}

#[derive(Debug, PartialEq, Eq)]
pub enum PromoteError {
    ItemIdentityRequired,
    TypesRequired,
    ReasonRequired,
    SimilarityOnlyForbidden,
    ReasonInvalid,
    TransitionNotAllowed,
    RecurrenceBelowThreshold,
}

impl PromoteError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ItemIdentityRequired => "item_identity_required",
            Self::TypesRequired => "types_required",
            Self::ReasonRequired => "reason_required",
            Self::SimilarityOnlyForbidden => "similarity_only_forbidden",
            Self::ReasonInvalid => "reason_invalid",
            Self::TransitionNotAllowed => "transition_not_allowed",
            Self::RecurrenceBelowThreshold => "recurrence_below_threshold",
        }
    }
}

/// Plan soft_close + insert_promoted (never UPDATE memory_type in place).
pub fn plan_promotion(input: &Value) -> Result<Value, PromoteError> {
    let item_id = input.get("item_id").and_then(|v| v.as_str()).unwrap_or("");
    let created_at = input.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
    if item_id.is_empty() || created_at.is_empty() {
        return Err(PromoteError::ItemIdentityRequired);
    }
    let from_type = input.get("from_type").and_then(|v| v.as_str()).unwrap_or("");
    let to_type = input.get("to_type").and_then(|v| v.as_str()).unwrap_or("");
    if from_type.is_empty() || to_type.is_empty() {
        return Err(PromoteError::TypesRequired);
    }
    let reason = input.get("reason").and_then(|v| v.as_str()).unwrap_or("");
    if reason.is_empty() {
        return Err(PromoteError::ReasonRequired);
    }
    if reason == "similarity_only" {
        return Err(PromoteError::SimilarityOnlyForbidden);
    }
    if !valid_reasons().contains(reason) {
        return Err(PromoteError::ReasonInvalid);
    }
    if !is_allowed_transition(from_type, to_type) {
        return Err(PromoteError::TransitionNotAllowed);
    }
    if reason == "recurrence" {
        let n = input
            .get("evidence_count")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if n < RECURRENCE_MIN_EVIDENCE {
            return Err(PromoteError::RecurrenceBelowThreshold);
        }
    }
    Ok(json!({
        "ok": true,
        "ops": [
            { "op": "soft_close", "item_id": item_id },
            {
                "op": "insert_promoted",
                "memory_type": to_type,
                "supersedes_id": item_id,
                "created_at": created_at,
                "reason": reason
            }
        ]
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transitions_and_similarity_forbidden() {
        assert!(is_allowed_transition("short_term", "episodic"));
        assert!(is_allowed_transition("episodic", "long_term"));
        assert!(is_allowed_transition("episodic", "semantic"));
        assert!(!is_allowed_transition("short_term", "long_term"));
        let err = plan_promotion(&json!({
            "from_type":"episodic","to_type":"long_term",
            "reason":"similarity_only","similarity":0.99,
            "item_id":"22222222-2222-2222-2222-222222222222",
            "created_at":"2026-10-01T00:00:00.000Z"
        }))
        .unwrap_err();
        assert_eq!(err.code(), "similarity_only_forbidden");
    }

    #[test]
    fn soft_close_insert_promoted() {
        let plan = plan_promotion(&json!({
            "from_type":"short_term","to_type":"episodic",
            "reason":"session_boundary",
            "item_id":"11111111-1111-1111-1111-111111111111",
            "created_at":"2026-11-01T00:00:00.000Z"
        }))
        .unwrap();
        assert_eq!(plan["ok"], true);
        assert_eq!(plan["ops"][0]["op"], "soft_close");
        assert_eq!(plan["ops"][1]["op"], "insert_promoted");
        assert_eq!(plan["ops"][1]["memory_type"], "episodic");
    }
}
