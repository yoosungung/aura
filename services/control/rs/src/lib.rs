//! svc-control resolve + admin wire helpers (Phase 3).
//! Live Pooler DSN = canary; local path uses StubPooler only.

use aura_otel::mask_secrets;
use aura_tenant_tx::SET_TENANT_GUC_SQL;
use serde_json::{json, Map, Value};
use std::cell::Cell;
use std::collections::HashSet;

#[cfg(test)]
mod parity_tests;

const RUNTIMES: &[&str] = &["nodejs", "python", "custom"];
const DEFAULT_RUNTIME: &str = "nodejs";

fn is_plain_object(v: &Value) -> bool {
    v.is_object()
}

pub fn normalize_runtime(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str())
        .filter(|s| RUNTIMES.contains(s))
        .unwrap_or(DEFAULT_RUNTIME)
        .to_string()
}

/// 1-depth section merge; user wins. Source/user are not mutated.
pub fn merge_configs(source_cfg: &Value, user_cfg: &Value) -> Value {
    let mut base: Map<String, Value> = source_cfg.as_object().cloned().unwrap_or_default();
    let Some(user) = user_cfg.as_object() else {
        return Value::Object(base);
    };
    if user.is_empty() {
        return Value::Object(base);
    }
    for (k, user_val) in user {
        match (base.get(k), user_val) {
            (Some(Value::Object(src)), Value::Object(u)) => {
                let mut merged = src.clone();
                for (uk, uv) in u {
                    merged.insert(uk.clone(), uv.clone());
                }
                base.insert(k.clone(), Value::Object(merged));
            }
            _ => {
                base.insert(k.clone(), user_val.clone());
            }
        }
    }
    Value::Object(base)
}

pub fn validate_resolve_request(req: &Value) -> Result<(), String> {
    if !is_plain_object(req) {
        return Err("request_not_object".into());
    }
    let tenant_id = req.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
    if tenant_id.is_empty() {
        return Err("tenant_id_required".into());
    }
    let kind = req.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    if kind != "agent" && kind != "mcp" {
        return Err("kind_invalid".into());
    }
    if req.get("name").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        return Err("name_required".into());
    }
    if req.get("version").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        return Err("version_required".into());
    }
    let principal = req.get("principal").ok_or_else(|| "principal_id_required".to_string())?;
    let pid = principal.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if pid.is_empty() {
        return Err("principal_id_required".into());
    }
    let ptenant = principal
        .get("tenant_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if ptenant.is_empty() {
        return Err("principal_tenant_required".into());
    }
    if ptenant != tenant_id {
        return Err("tenant_mismatch".into());
    }
    Ok(())
}

fn public_source(source: &Value) -> Value {
    let runtime = normalize_runtime(source.get("runtime"));
    json!({
        "id": source.get("id"),
        "tenant_id": source.get("tenant_id"),
        "kind": source.get("kind"),
        "name": source.get("name"),
        "version": source.get("version"),
        "entrypoint": source.get("entrypoint").cloned().unwrap_or(Value::Null),
        "function": source.get("function").cloned().unwrap_or(Value::Null),
        "bundle_uri": source.get("bundle_uri"),
        "checksum": source.get("checksum"),
        "sig_uri": source.get("sig_uri").cloned().unwrap_or(Value::Null),
        "config": source.get("config").cloned().unwrap_or_else(|| json!({})),
        "runtime": runtime,
        "status": source.get("status"),
        "created_at": source.get("created_at"),
    })
}

fn public_user(user: Option<&Value>) -> Value {
    let Some(user) = user else {
        return Value::Null;
    };
    json!({
        "id": user.get("id"),
        "tenant_id": user.get("tenant_id"),
        "source_meta_id": user.get("source_meta_id"),
        "principal_id": user.get("principal_id"),
        "config": user.get("config").cloned().unwrap_or_else(|| json!({})),
        "secrets_ref": user.get("secrets_ref").cloned().unwrap_or(Value::Null),
        "updated_at": user.get("updated_at"),
    })
}

/// Build resolve RPC response from rows (already tenant-scoped). Node parity.
pub fn build_resolve_response(source: &Value, user: Option<&Value>) -> Value {
    let status = source.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if status != "active" {
        return json!({
            "type": "control.resolve.error",
            "error": "source_not_active",
        });
    }
    let src = public_source(source);
    let usr = public_user(user);
    let cfg = merge_configs(
        src.get("config").unwrap_or(&json!({})),
        usr.get("config").unwrap_or(&Value::Null),
    );
    let secrets_ref = usr.get("secrets_ref").cloned().unwrap_or(Value::Null);
    let runtime = src.get("runtime").cloned().unwrap_or_else(|| json!(DEFAULT_RUNTIME));
    let function = src.get("function").cloned().unwrap_or(Value::Null);
    let mut out = json!({
        "type": "control.resolve.done",
        "source": src,
        "user": usr,
        "cfg": cfg,
        "secrets_ref": secrets_ref,
        "runtime": runtime,
        "function": function,
    });
    if let Some(obj) = out.as_object_mut() {
        obj.remove("secrets");
    }
    out
}

pub fn tenant_guc_sql() -> &'static str {
    SET_TENANT_GUC_SQL
}

/// Pooler lookup surface — production uses sqlx; local = StubPooler.
pub trait PoolerLookup {
    fn set_tenant_guc(&self, tenant_id: &str, is_local: bool) -> Result<(), String>;
    fn lookup_source(
        &self,
        tenant_id: &str,
        kind: &str,
        name: &str,
        version: &str,
    ) -> Result<Option<Value>, String>;
    fn lookup_user(
        &self,
        tenant_id: &str,
        source_id: &str,
        principal_id: &str,
    ) -> Result<Option<Value>, String>;
}

#[derive(Default)]
pub struct StubPooler {
    source: Option<Value>,
    user: Option<Value>,
    last_guc_local: Cell<Option<bool>>,
}

impl StubPooler {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn with_source(source: Value) -> Self {
        Self {
            source: Some(source),
            user: None,
            last_guc_local: Cell::new(None),
        }
    }

    pub fn last_guc_is_local(&self) -> Option<bool> {
        self.last_guc_local.get()
    }
}

impl PoolerLookup for StubPooler {
    fn set_tenant_guc(&self, tenant_id: &str, is_local: bool) -> Result<(), String> {
        if tenant_id.trim().is_empty() {
            return Err("tenant_id_required".into());
        }
        if !is_local {
            return Err("session_guc_forbidden".into());
        }
        self.last_guc_local.set(Some(true));
        Ok(())
    }

    fn lookup_source(
        &self,
        _tenant_id: &str,
        _kind: &str,
        _name: &str,
        _version: &str,
    ) -> Result<Option<Value>, String> {
        Ok(self.source.clone())
    }

    fn lookup_user(
        &self,
        _tenant_id: &str,
        _source_id: &str,
        _principal_id: &str,
    ) -> Result<Option<Value>, String> {
        Ok(self.user.clone())
    }
}

pub fn resolve_with_pooler(
    req: &Value,
    pooler: &dyn PoolerLookup,
) -> Result<Value, String> {
    validate_resolve_request(req)?;
    let tenant_id = req.get("tenant_id").and_then(|v| v.as_str()).unwrap();
    pooler.set_tenant_guc(tenant_id, true)?;
    let kind = req.get("kind").and_then(|v| v.as_str()).unwrap();
    let name = req.get("name").and_then(|v| v.as_str()).unwrap();
    let version = req.get("version").and_then(|v| v.as_str()).unwrap();
    let principal_id = req["principal"]["id"].as_str().unwrap();

    let Some(source) = pooler.lookup_source(tenant_id, kind, name, version)? else {
        return Ok(json!({
            "type": "control.resolve.error",
            "error": "source_not_found",
        }));
    };
    let source_id = source.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let user = pooler.lookup_user(tenant_id, source_id, principal_id)?;
    Ok(build_resolve_response(&source, user.as_ref()))
}

pub fn admin_list_tenants_stub() -> (u16, Value) {
    (200, json!({"tenants":[]}))
}

pub fn admin_audit_insert_shape(tenant_id: &str, actor: &str, action: &str) -> Value {
    mask_secrets(&json!({
        "tenant_id": tenant_id,
        "actor": actor,
        "action": action,
        "token": "should-mask",
    }))
}

pub fn mask_admin_payload(v: &Value) -> Value {
    mask_secrets(v)
}

pub fn admin_post_audit_stub(
    tenant_id: &str,
    actor: &str,
    action: &str,
    reason: Option<&str>,
) -> (u16, Value) {
    let mut row = admin_audit_insert_shape(tenant_id, actor, action);
    if let Some(r) = reason {
        row["reason"] = json!(r);
    }
    (
        201,
        json!({
            "ok": true,
            "row": row,
        }),
    )
}

pub fn allowed_admin_paths() -> HashSet<&'static str> {
    HashSet::from([
        "/v1/tenants",
        "/v1/sources",
        "/v1/overlays",
        "/v1/audit",
        "/v1/quotas",
    ])
}
