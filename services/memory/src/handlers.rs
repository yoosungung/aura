//! Domain handlers (wire stubs) — live Pooler/sqlx = canary follow-up.

use crate::{
    embed_plan, object_gc_batch_key, promote::plan_promotion, recall_request_ok,
    should_skip_object_gc, ARCHIVE_TASK, CONSOLIDATE_TASK, OBJECT_GC_TASK, TTL_TASK,
};
use serde_json::{json, Value};

fn tenant_id(v: &Value) -> &str {
    v.get("tenant_id").and_then(|x| x.as_str()).unwrap_or("")
}

fn req_id(v: &Value) -> &str {
    v.get("id").and_then(|x| x.as_str()).unwrap_or("")
}

fn parse(raw: &[u8]) -> Result<Value, String> {
    if raw.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(raw).map_err(|e| format!("invalid_json:{e}"))
}

/// store module boundary (capture calls this plan; standalone store Deployment retired).
pub fn handle_store_request(raw: &[u8]) -> Result<(u16, String), String> {
    let v = parse(raw)?;
    let tenant = tenant_id(&v);
    if tenant.is_empty() {
        return Ok((
            400,
            json!({"type":"memory.stored.error","error":"tenant_id_required"}).to_string(),
        ));
    }
    let items = v
        .pointer("/payload/items")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    Ok((
        200,
        json!({
            "type": "memory.stored",
            "id": req_id(&v),
            "tenant_id": tenant,
            "payload": { "status": "accepted_stub", "count": items.len() }
        })
        .to_string(),
    ))
}

pub fn handle_embed_request(raw: &[u8]) -> Result<(u16, String), String> {
    let v = parse(raw)?;
    let tenant = tenant_id(&v);
    if tenant.is_empty() {
        return Ok((
            400,
            json!({"type":"memory.embedded.error","error":"tenant_id_required"}).to_string(),
        ));
    }
    let items = v
        .pointer("/payload/items")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let plan = embed_plan(&items);
    Ok((
        200,
        json!({
            "type": "memory.embedded",
            "id": req_id(&v),
            "tenant_id": tenant,
            "payload": {
                "status": "accepted_stub",
                "skip_ids": plan.skip_ids,
                "embed_ids": plan.embed_ids
            }
        })
        .to_string(),
    ))
}

pub fn handle_recall_request(raw: &[u8]) -> Result<(u16, String), String> {
    let v = parse(raw)?;
    if !recall_request_ok(&v) {
        // also accept envelope shape tenant_id + payload.query
        let tenant = tenant_id(&v);
        let query = v
            .pointer("/payload/query")
            .and_then(|x| x.as_str())
            .or_else(|| v.get("query").and_then(|x| x.as_str()))
            .unwrap_or("");
        if tenant.is_empty() || query.is_empty() {
            return Ok((
                400,
                json!({
                    "type": "memory.recall.error",
                    "ok": false,
                    "error": "tenant_id_and_query_required",
                    "subject": "aura.rpc.memory.recall"
                })
                .to_string(),
            ));
        }
    }
    let tenant = tenant_id(&v);
    Ok((
        200,
        json!({
            "type": "memory.recall.done",
            "id": req_id(&v),
            "tenant_id": tenant,
            "payload": {
                "mode": "hybrid_rrf",
                "items": [],
                "status": "accepted_stub"
            }
        })
        .to_string(),
    ))
}

pub fn handle_consolidate_request(raw: &[u8]) -> Result<(u16, String), String> {
    let v = parse(raw)?;
    let tenant = tenant_id(&v);
    let id = req_id(&v);
    if tenant.is_empty() || id.is_empty() {
        return Ok((
            400,
            json!({"type":"memory.consolidate.error","error":"tenant_id_and_id_required"}).to_string(),
        ));
    }
    let payload = v.get("payload").cloned().unwrap_or(json!({}));
    match plan_promotion(&payload) {
        Ok(plan) => Ok((
            200,
            json!({
                "type": "memory.consolidated",
                "id": id,
                "tenant_id": tenant,
                "payload": {
                    "task": CONSOLIDATE_TASK,
                    "status": "accepted_stub",
                    "plan": plan
                }
            })
            .to_string(),
        )),
        Err(e) => Ok((
            400,
            json!({
                "type": "memory.consolidate.error",
                "id": id,
                "tenant_id": tenant,
                "error": e.code()
            })
            .to_string(),
        )),
    }
}

pub fn handle_ttl_request(raw: &[u8]) -> Result<(u16, String), String> {
    let v = parse(raw)?;
    let tenant = tenant_id(&v);
    Ok((
        200,
        json!({
            "type": "memory.ttl.done",
            "id": req_id(&v),
            "tenant_id": tenant,
            "payload": { "task": TTL_TASK, "status": "accepted_stub", "action": "DROP_TABLE_plan" }
        })
        .to_string(),
    ))
}

pub fn handle_archive_request(raw: &[u8]) -> Result<(u16, String), String> {
    let v = parse(raw)?;
    let tenant = tenant_id(&v);
    Ok((
        200,
        json!({
            "type": "memory.archived",
            "id": req_id(&v),
            "tenant_id": tenant,
            "payload": {
                "task": ARCHIVE_TASK,
                "status": "accepted_stub",
                "order": ["putObject", "DETACH PARTITION", "DROP TABLE"]
            }
        })
        .to_string(),
    ))
}

pub fn handle_object_gc_request(raw: &[u8]) -> Result<(u16, String), String> {
    let v = parse(raw)?;
    let tenant = tenant_id(&v);
    let scope = v
        .pointer("/payload/scope")
        .and_then(|x| x.as_str())
        .unwrap_or("all");
    let day = v
        .pointer("/payload/yyyy_mm_dd")
        .and_then(|x| x.as_str())
        .unwrap_or("1970-01-01");
    let ref_linked = v
        .pointer("/payload/ref_still_linked")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let skipped = should_skip_object_gc(ref_linked);
    Ok((
        200,
        json!({
            "type": "memory.object_gc.done",
            "id": req_id(&v),
            "tenant_id": tenant,
            "payload": {
                "task": OBJECT_GC_TASK,
                "status": if skipped { "skipped_ref_linked" } else { "accepted_stub" },
                "batch_key": object_gc_batch_key(scope, day)
            }
        })
        .to_string(),
    ))
}
