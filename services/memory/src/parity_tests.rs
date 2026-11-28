//! svc-memory handler guards parity — live PG/S3 skipped (Phase 4).

use crate::*;
use serde_json::json;

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
