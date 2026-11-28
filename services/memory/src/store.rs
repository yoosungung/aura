//! memory_items INSERT/UPSERT via withTenantTx (ARCHITECTURE §6 · M1).
//!
//! Live sqlx Pooler wiring is a follow-up; this module owns the write SQL and
//! GUC transaction shape. Capture must call here — no SQL in capture.rs.

use aura_tenant_tx::{require_tenant_id, SET_TENANT_GUC_SQL};
use serde_json::{json, Value};
use thiserror::Error;

/// Idempotent upsert — PK is (id, memory_type, created_at). Do not INSERT content_tsv
/// (GENERATED ALWAYS AS to_tsvector).
pub const UPSERT_MEMORY_ITEM_SQL: &str = "\
INSERT INTO memory_items (\
  id, tenant_id, memory_type, content, metadata, \
  session_id, principal_id, agent_id, run_id, \
  source_event_id, created_at, updated_at\
) VALUES (\
  $1::uuid, $2::uuid, $3::memory_type, $4, $5::jsonb, \
  $6, $7, $8, $9, \
  $10::uuid, COALESCE($11::timestamptz, now()), now()\
) ON CONFLICT (id, memory_type, created_at) DO UPDATE SET \
  content = EXCLUDED.content, \
  metadata = EXCLUDED.metadata, \
  updated_at = now()\
RETURNING id, memory_type, created_at, (content_tsv IS NOT NULL) AS has_tsv";

const VALID_TYPES: &[&str] = &["short_term", "long_term", "episodic", "semantic"];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum StoreError {
    #[error("tenant_id_required")]
    TenantIdRequired,
    #[error("id_required")]
    IdRequired,
    #[error("memory_type_required")]
    MemoryTypeRequired,
    #[error("memory_type_invalid")]
    MemoryTypeInvalid,
    #[error("content_or_content_ref_required")]
    ContentOrRefRequired,
    #[error("query_failed:{0}")]
    QueryFailed(String),
}

impl StoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::TenantIdRequired => "tenant_id_required",
            Self::IdRequired => "id_required",
            Self::MemoryTypeRequired => "memory_type_required",
            Self::MemoryTypeInvalid => "memory_type_invalid",
            Self::ContentOrRefRequired => "content_or_content_ref_required",
            Self::QueryFailed(_) => "store_query_failed",
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            Self::QueryFailed(_) => 500,
            _ => 400,
        }
    }
}

/// Minimal injectable client (Node `client.query` parity · sqlx later).
pub trait PgClient {
    fn query(&mut self, sql: &str, params: &[Value]) -> Result<Vec<Value>, StoreError>;
}

/// In-memory recorder for unit tests / wire path without live Pooler.
#[derive(Debug, Default)]
pub struct RecordingClient {
    pub calls: Vec<(String, Vec<Value>)>,
}

impl PgClient for RecordingClient {
    fn query(&mut self, sql: &str, params: &[Value]) -> Result<Vec<Value>, StoreError> {
        self.calls.push((sql.to_string(), params.to_vec()));
        if sql.contains("INSERT INTO memory_items") {
            return Ok(vec![json!({
                "id": params.first().cloned().unwrap_or(Value::Null),
                "has_tsv": true
            })]);
        }
        Ok(vec![])
    }
}

#[derive(Debug, Clone)]
pub struct StoreItem {
    pub id: String,
    pub memory_type: String,
    pub content: Option<String>,
    pub content_ref: Option<Value>,
    pub created_at: Option<String>,
    pub session_id: Option<String>,
    pub principal_id: Option<String>,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub source_event_id: Option<String>,
    pub metadata: Value,
}

impl StoreItem {
    pub fn from_value(v: &Value, fallback_id: Option<&str>) -> Result<Self, StoreError> {
        let id = v
            .get("id")
            .and_then(|x| x.as_str())
            .or(fallback_id)
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            return Err(StoreError::IdRequired);
        }
        let memory_type = v
            .get("memory_type")
            .or_else(|| v.get("kind"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if memory_type.is_empty() {
            return Err(StoreError::MemoryTypeRequired);
        }
        if !VALID_TYPES.contains(&memory_type.as_str()) {
            return Err(StoreError::MemoryTypeInvalid);
        }
        let content = v
            .get("content")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let content_ref = v
            .get("content_ref")
            .cloned()
            .filter(|x| !x.is_null());
        if content.as_ref().map(|s| s.is_empty()).unwrap_or(true) && content_ref.is_none() {
            // also allow metadata.content_ref
            let meta_ref = v.pointer("/metadata/content_ref").cloned().filter(|x| !x.is_null());
            if meta_ref.is_none() {
                return Err(StoreError::ContentOrRefRequired);
            }
            return Ok(Self {
                id,
                memory_type,
                content: Some(String::new()),
                content_ref: meta_ref,
                created_at: v
                    .get("created_at")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                session_id: opt_str(v, "session_id"),
                principal_id: opt_str(v, "principal_id"),
                agent_id: opt_str(v, "agent_id"),
                run_id: opt_str(v, "run_id"),
                source_event_id: opt_str(v, "source_event_id"),
                metadata: v.get("metadata").cloned().unwrap_or_else(|| json!({})),
            });
        }
        Ok(Self {
            id,
            memory_type,
            content,
            content_ref,
            created_at: v
                .get("created_at")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            session_id: opt_str(v, "session_id"),
            principal_id: opt_str(v, "principal_id"),
            agent_id: opt_str(v, "agent_id"),
            run_id: opt_str(v, "run_id"),
            source_event_id: opt_str(v, "source_event_id"),
            metadata: v.get("metadata").cloned().unwrap_or_else(|| json!({})),
        })
    }

    fn resolved_content(&self) -> String {
        self.content.clone().unwrap_or_default()
    }

    fn resolved_metadata(&self) -> Value {
        let mut meta = self.metadata.clone();
        if let Some(ref r) = self.content_ref {
            if let Some(obj) = meta.as_object_mut() {
                obj.insert("content_ref".into(), r.clone());
            }
        }
        meta
    }
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// BEGIN → set_config(..., true) → fn → COMMIT (ROLLBACK on error).
pub fn with_tenant_tx<C, T, F>(client: &mut C, tenant_id: &str, f: F) -> Result<T, StoreError>
where
    C: PgClient,
    F: FnOnce(&mut C) -> Result<T, StoreError>,
{
    require_tenant_id(tenant_id).map_err(|_| StoreError::TenantIdRequired)?;
    client.query("BEGIN", &[])?;
    if let Err(e) = client.query(SET_TENANT_GUC_SQL, &[json!(tenant_id)]) {
        let _ = client.query("ROLLBACK", &[]);
        return Err(e);
    }
    match f(client) {
        Ok(v) => {
            client.query("COMMIT", &[])?;
            Ok(v)
        }
        Err(e) => {
            let _ = client.query("ROLLBACK", &[]);
            Err(e)
        }
    }
}

/// Upsert one memory_items row under tenant GUC.
pub fn store_once<C: PgClient>(
    client: &mut C,
    tenant_id: &str,
    item: &StoreItem,
) -> Result<Value, StoreError> {
    with_tenant_tx(client, tenant_id, |c| {
        let meta = item.resolved_metadata();
        let params = vec![
            json!(item.id),
            json!(tenant_id),
            json!(item.memory_type),
            json!(item.resolved_content()),
            meta,
            json!(item.session_id),
            json!(item.principal_id),
            json!(item.agent_id),
            json!(item.run_id),
            json!(item.source_event_id),
            json!(item.created_at),
        ];
        let rows = c.query(UPSERT_MEMORY_ITEM_SQL, &params)?;
        Ok(json!({
            "id": item.id,
            "memory_type": item.memory_type,
            "status": "accepted",
            "has_tsv": rows.first().and_then(|r| r.get("has_tsv")).cloned().unwrap_or(json!(true))
        }))
    })
}

/// Upsert many items in one tenant transaction (capture batch).
pub fn store_items<C: PgClient>(
    client: &mut C,
    tenant_id: &str,
    items: &[StoreItem],
) -> Result<Vec<Value>, StoreError> {
    with_tenant_tx(client, tenant_id, |c| {
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let meta = item.resolved_metadata();
            let params = vec![
                json!(item.id),
                json!(tenant_id),
                json!(item.memory_type),
                json!(item.resolved_content()),
                meta,
                json!(item.session_id),
                json!(item.principal_id),
                json!(item.agent_id),
                json!(item.run_id),
                json!(item.source_event_id),
                json!(item.created_at),
            ];
            let rows = c.query(UPSERT_MEMORY_ITEM_SQL, &params)?;
            out.push(json!({
                "id": item.id,
                "memory_type": item.memory_type,
                "status": "accepted",
                "has_tsv": rows.first().and_then(|r| r.get("has_tsv")).cloned().unwrap_or(json!(true))
            }));
        }
        Ok(out)
    })
}

/// Plan status for capture (no PG) — real write uses store_once/store_items.
pub fn plan_store_status(memory_type: &str) -> Value {
    json!({
        "status": "accepted",
        "memory_type": memory_type
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_sql_contract() {
        assert!(UPSERT_MEMORY_ITEM_SQL.contains("INSERT INTO memory_items"));
        assert!(UPSERT_MEMORY_ITEM_SQL.contains("ON CONFLICT (id, memory_type, created_at)"));
        assert!(!UPSERT_MEMORY_ITEM_SQL.contains("content_tsv,"));
        assert!(UPSERT_MEMORY_ITEM_SQL.contains("has_tsv"));
        assert!(!UPSERT_MEMORY_ITEM_SQL.contains("SELECT $1"));
    }

    #[test]
    fn store_once_uses_guc_then_insert() {
        let mut client = RecordingClient::default();
        let item = StoreItem::from_value(
            &json!({
                "id": "11111111-1111-1111-1111-111111111111",
                "memory_type": "short_term",
                "content": "hello",
                "created_at": "2026-11-28T00:00:00Z"
            }),
            None,
        )
        .unwrap();
        let out = store_once(
            &mut client,
            "22222222-2222-2222-2222-222222222222",
            &item,
        )
        .unwrap();
        assert_eq!(out["status"], "accepted");
        assert_eq!(client.calls[0].0, "BEGIN");
        assert!(client.calls[1].0.contains("set_config('app.tenant_id'"));
        assert!(client.calls[1].0.contains(", true)"));
        assert!(!client.calls[1].0.contains(", false)"));
        assert!(client.calls[2].0.contains("INSERT INTO memory_items"));
        assert!(client.calls[2].0.contains("ON CONFLICT"));
        assert_eq!(client.calls[3].0, "COMMIT");
    }

    #[test]
    fn idempotent_same_pk_reupsert() {
        let mut client = RecordingClient::default();
        let item = StoreItem::from_value(
            &json!({
                "id": "11111111-1111-1111-1111-111111111111",
                "kind": "episodic",
                "content": "v1",
                "created_at": "2026-11-01T00:00:00Z"
            }),
            None,
        )
        .unwrap();
        let tenant = "22222222-2222-2222-2222-222222222222";
        store_once(&mut client, tenant, &item).unwrap();
        let mut item2 = item.clone();
        item2.content = Some("v2".into());
        store_once(&mut client, tenant, &item2).unwrap();
        let inserts: Vec<_> = client
            .calls
            .iter()
            .filter(|(s, _)| s.contains("INSERT INTO memory_items"))
            .collect();
        assert_eq!(inserts.len(), 2);
        assert_eq!(inserts[1].1[3], json!("v2"));
    }

    #[test]
    fn content_ref_only_ok() {
        let item = StoreItem::from_value(
            &json!({
                "id": "11111111-1111-1111-1111-111111111111",
                "memory_type": "long_term",
                "content_ref": {
                    "scheme": "s3",
                    "bucket": "aura-content",
                    "key": "tenants/t/refs/2026/11/x",
                    "size_bytes": 400000
                }
            }),
            None,
        )
        .unwrap();
        assert_eq!(item.resolved_content(), "");
        assert_eq!(item.resolved_metadata()["content_ref"]["scheme"], "s3");
    }

    #[test]
    fn rejects_missing_content_and_ref() {
        let err = StoreItem::from_value(
            &json!({"id":"1","memory_type":"short_term"}),
            None,
        )
        .unwrap_err();
        assert_eq!(err, StoreError::ContentOrRefRequired);
    }
}
