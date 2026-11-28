//! svc-memory handlers — Phase 4 Rust cutover (wire stubs · live PG/S3 = canary).

use aura_tenant_tx::SET_TENANT_GUC_SQL;
use serde_json::Value;

pub mod batch_payload;
pub mod capture;
pub mod handlers;
pub mod promote;

#[cfg(test)]
mod parity_tests;

pub const STORE_TASK: &str = "aura.tasks.memory.store";
pub const EMBED_TASK: &str = "aura.tasks.memory.embed";
pub const RECALL_RPC: &str = "aura.rpc.memory.recall";
pub const CONSOLIDATE_TASK: &str = "aura.tasks.memory.consolidate";
pub const TTL_TASK: &str = "aura.tasks.memory.ttl";
pub const ARCHIVE_TASK: &str = "aura.tasks.memory.archive";
pub const OBJECT_GC_TASK: &str = "aura.tasks.memory.object_gc";

/// Supernode fixture contract (ARCHITECTURE §6.2.4) — hub ≫ walk caps.
pub const SUPERNODE_HUB_DEGREE: u32 = 500;
pub const SUPERNODE_DEGREE_CAP: u32 = 64;
pub const SUPERNODE_PER_HOP_LIMIT: u32 = 50;

/// Graph walk limits (ARCHITECTURE §6.2.4 · former graph-walk.js GRAPH_LIMITS).
pub const GRAPH_MAX_DEPTH: u32 = 2;
pub const GRAPH_PER_HOP_LIMIT: u32 = 50;
pub const GRAPH_MAX_NODES_TOTAL: u32 = 100;
pub const GRAPH_MAX_EDGES_TOTAL: u32 = 200;
pub const GRAPH_SUPERNODE_DEGREE_CAP: u32 = 64;

pub fn tenant_guc_sql() -> &'static str {
    SET_TENANT_GUC_SQL
}

/// short_term items must not be embedded.
pub fn should_skip_embed(kind: &str) -> bool {
    kind == "short_term"
}

/// Skip Delete when content_ref still referenced.
pub fn should_skip_object_gc(ref_still_linked: bool) -> bool {
    ref_still_linked
}

pub fn idempotency_key(task: &str, tenant_id: &str, request_id: &str) -> String {
    format!("{task}:{tenant_id}:{request_id}")
}

pub fn object_gc_batch_key(scope: &str, yyyy_mm_dd: &str) -> String {
    format!("object-gc:{scope}:{yyyy_mm_dd}")
}

pub fn store_item_kind(item: &Value) -> Option<&str> {
    item.get("kind").and_then(|v| v.as_str())
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct EmbedPlan {
    pub skip_ids: Vec<String>,
    pub embed_ids: Vec<String>,
}

pub fn embed_plan(items: &[Value]) -> EmbedPlan {
    let mut plan = EmbedPlan::default();
    for item in items {
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let kind = store_item_kind(item).unwrap_or("");
        if should_skip_embed(kind) {
            plan.skip_ids.push(id);
        } else {
            plan.embed_ids.push(id);
        }
    }
    plan
}

pub fn recall_request_ok(body: &Value) -> bool {
    let tenant = body.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
    let query = body.get("query").and_then(|v| v.as_str()).unwrap_or("");
    !tenant.is_empty() && !query.is_empty()
}
