//! svc-memory handler guards parity — live PG/S3 skipped (Phase 4).

use crate::*;
use serde_json::json;

#[test]
fn supernode_caps() {
    assert_eq!(SUPERNODE_HUB_DEGREE, 500);
    assert!(SUPERNODE_HUB_DEGREE > SUPERNODE_DEGREE_CAP);
    assert!(SUPERNODE_HUB_DEGREE > SUPERNODE_PER_HOP_LIMIT);
    assert_eq!(SUPERNODE_DEGREE_CAP, 64);
    assert_eq!(SUPERNODE_PER_HOP_LIMIT, 50);
    assert_eq!(GRAPH_MAX_DEPTH, 2);
    assert_eq!(GRAPH_PER_HOP_LIMIT, 50);
    assert_eq!(GRAPH_MAX_NODES_TOTAL, 100);
    assert_eq!(GRAPH_MAX_EDGES_TOTAL, 200);
    assert_eq!(GRAPH_SUPERNODE_DEGREE_CAP, 64);
}

#[test]
fn pipeline_subjects_order() {
    assert_eq!(STORE_TASK, "aura.tasks.memory.store");
    assert_eq!(EMBED_TASK, "aura.tasks.memory.embed");
    assert_eq!(RECALL_RPC, "aura.rpc.memory.recall");
    assert_eq!(CONSOLIDATE_TASK, "aura.tasks.memory.consolidate");
    assert_eq!(TTL_TASK, "aura.tasks.memory.ttl");
    assert_eq!(ARCHIVE_TASK, "aura.tasks.memory.archive");
    assert_eq!(OBJECT_GC_TASK, "aura.tasks.memory.object_gc");
}

#[test]
fn short_term_embed_skip_and_guc() {
    assert!(should_skip_embed("short_term"));
    assert!(!should_skip_embed("episodic"));
    assert!(!should_skip_embed("semantic"));
    assert!(tenant_guc_sql().contains("set_config('app.tenant_id', $1, true)"));
    assert!(!tenant_guc_sql().contains(", false)"));
}

#[test]
fn object_gc_and_idempotency() {
    assert!(should_skip_object_gc(true));
    assert!(!should_skip_object_gc(false));
    assert_eq!(
        idempotency_key(OBJECT_GC_TASK, "t", "2026-11-28"),
        "aura.tasks.memory.object_gc:t:2026-11-28"
    );
    assert_eq!(
        object_gc_batch_key("all", "2026-11-28"),
        "object-gc:all:2026-11-28"
    );
}

#[test]
fn wire_handlers_stub_ok() {
    use crate::handlers::*;
    let (st, body) = handle_store_request(
        br#"{"id":"11111111-1111-1111-1111-111111111111","tenant_id":"22222222-2222-2222-2222-222222222222","payload":{"items":[{"id":"33333333-3333-3333-3333-333333333333","kind":"episodic","content":"hi","created_at":"2026-11-28T00:00:00Z"}]}}"#,
    )
    .unwrap();
    assert_eq!(st, 200);
    assert!(body.contains("memory.stored"));
    assert!(body.contains("\"status\":\"accepted\""));
    assert!(!body.contains("accepted_stub"));
    let (st, body) = handle_recall_request(br#"{"tenant_id":"t","query":"hi"}"#).unwrap();
    assert_eq!(st, 200);
    assert!(body.contains("hybrid_rrf"));
    let (st, body) = handle_object_gc_request(
        br#"{"tenant_id":"t","payload":{"scope":"all","yyyy_mm_dd":"2026-11-28","ref_still_linked":true}}"#,
    )
    .unwrap();
    assert_eq!(st, 200);
    assert!(body.contains("skipped_ref_linked"));
}

#[test]
fn store_and_recall_helpers() {
    assert_eq!(
        store_item_kind(&json!({"kind":"episodic","text":"x"})),
        Some("episodic")
    );
    let plan = embed_plan(&[
        json!({"kind":"short_term","id":"1"}),
        json!({"kind":"episodic","id":"2"}),
    ]);
    assert_eq!(plan.skip_ids, vec!["1"]);
    assert_eq!(plan.embed_ids, vec!["2"]);

    let recall = recall_request_ok(&json!({
        "tenant_id":"t","query":"hello","limit":10
    }));
    assert!(recall);
    assert!(!recall_request_ok(&json!({"tenant_id":"t"})));
}

#[test]
fn capture_subjects_and_no_sqlx() {
    use crate::capture::*;
    assert_eq!(TASK_SUBJECT, "aura.tasks.memory.capture");
    assert_eq!(DONE_SUBJECT, "aura.events.memory.capture.done");
    assert_eq!(ERROR_SUBJECT, "aura.events.memory.capture.error");
    let manifest = include_str!("../Cargo.toml");
    assert!(!manifest.contains("sqlx"));
    assert!(!manifest.contains("postgres"));
    let lib = include_str!("capture.rs");
    assert!(!lib.contains("set_config"));
    assert!(!lib.contains("INSERT INTO"));
}

#[test]
fn capture_extract_embed_store_sequence() {
    use crate::capture::*;
    assert_eq!(extract_candidates("hi")[0]["memory_type"], "short_term");
    assert_eq!(
        extract_candidates_with_kind("trip", Some("episodic"))[0]["memory_type"],
        "episodic"
    );
    assert!(extract_candidates("   ").is_empty());
    assert_eq!(plan_embed("short_term")["status"], "skipped_short_term");
    assert_eq!(plan_embed("episodic")["status"], "accepted");
    assert_eq!(plan_store("episodic")["status"], "accepted");

    let env = handle_capture("tenant-a", "remember the meeting").unwrap();
    assert_eq!(env.event_type, "memory.capture.done");
    assert_eq!(env.tenant_id, "tenant-a");
    let cands = env.payload["candidates"].as_array().unwrap();
    let emb = env.payload["embedded"].as_array().unwrap();
    let stored = env.payload["stored"].as_array().unwrap();
    assert_eq!(cands.len(), 1);
    assert_eq!(cands[0]["memory_type"], "short_term");
    assert_eq!(emb.len(), 1);
    assert_eq!(emb[0]["status"], "skipped_short_term");
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0]["status"], "accepted");
    assert_eq!(handle_capture("t", "").unwrap_err(), CaptureError::TextRequired);
    assert_eq!(
        build_capture_done_envelope("", vec![], vec![], vec![]).unwrap_err(),
        CaptureError::TenantIdRequired
    );
}

