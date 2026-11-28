//! memory_capture Node handler.selftest parity — PG forbidden (Phase 4).

use crate::*;
use serde_json::json;

#[test]
fn subjects_and_no_pg() {
    assert_eq!(TASK_SUBJECT, "aura.tasks.memory.capture");
    assert_eq!(CANDIDATES_SUBJECT, "aura.events.memory.candidates");
    assert_eq!(ERROR_SUBJECT, "aura.events.memory.capture.error");
    let manifest = include_str!("../Cargo.toml");
    assert!(!manifest.contains("sqlx"));
    assert!(!manifest.contains("postgres"));
    let lib = include_str!("lib.rs");
    assert!(!lib.contains("set_config"));
}

#[test]
fn extract_and_envelope_management_consistency() {
    assert_eq!(extract_candidates("hi")[0]["kind"], "short_term");
    assert_eq!(extract_candidates(&"x".repeat(100))[0]["kind"], "episodic");
    assert!(extract_candidates("   ").is_empty());

    let env = handle_capture("tenant-a", "remember the meeting").unwrap();
    assert_eq!(env.event_type, "memory.candidates");
    assert_eq!(env.tenant_id, "tenant-a");
    let cands = env.payload["candidates"].as_array().unwrap();
    assert_eq!(cands.len(), 1);
    assert_eq!(cands[0]["kind"], "short_term");

    assert_eq!(
        handle_capture("t", "").unwrap_err(),
        CaptureError::TextRequired
    );
    assert_eq!(
        build_candidates_envelope("", vec![json!({"kind":"short_term"})]).unwrap_err(),
        CaptureError::TenantIdRequired
    );
}
