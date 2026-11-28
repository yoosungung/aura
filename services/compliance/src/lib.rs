//! compliance.erase — crypto-shred plan + wire stub (live OpenBao = canary).

use serde_json::{json, Value};

pub const TASK_SUBJECT: &str = "aura.tasks.compliance.erase";
pub const DONE_SUBJECT: &str = "aura.events.compliance.erase.done";
pub const ERROR_SUBJECT: &str = "aura.events.compliance.erase.error";
pub const KMS_PRODUCT: &str = "openbao-transit";
pub const BUCKET: &str = "aura-content";

pub const STEPS: &[&str] = &[
    "validate",
    "shred_keys",
    "invalidate_secrets_cache",
    "pg_redact",
    "delete_objects",
    "emit_done",
];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EraseError {
    #[error("tenant_id_required")]
    TenantIdRequired,
    #[error("user_id_required")]
    UserIdRequired,
    #[error("scope_invalid")]
    ScopeInvalid,
    #[error("key_version_invalid")]
    KeyVersionInvalid,
    #[error("invalid_json")]
    InvalidJson,
}

pub fn kid_tenant(tenant_id: &str, version: u64) -> String {
    format!("tenant:{tenant_id}:v{version}")
}

pub fn kid_user(tenant_id: &str, user_id: &str, version: u64) -> String {
    format!("tenant:{tenant_id}:user:{user_id}:v{version}")
}

pub fn resolve_kids(scope: &str, tenant_id: &str, user_id: Option<&str>, version: u64) -> Result<Vec<String>, EraseError> {
    if tenant_id.is_empty() {
        return Err(EraseError::TenantIdRequired);
    }
    if version < 1 {
        return Err(EraseError::KeyVersionInvalid);
    }
    match scope {
        "tenant" => Ok(vec![kid_tenant(tenant_id, version)]),
        "user" => {
            let uid = user_id.filter(|s| !s.is_empty()).ok_or(EraseError::UserIdRequired)?;
            Ok(vec![kid_user(tenant_id, uid, version)])
        }
        _ => Err(EraseError::ScopeInvalid),
    }
}

pub fn plan_erase(v: &Value) -> Result<Value, EraseError> {
    let tenant_id = v
        .get("tenant_id")
        .and_then(|x| x.as_str())
        .ok_or(EraseError::TenantIdRequired)?;
    let payload = v.get("payload").cloned().unwrap_or(json!({}));
    let scope = payload
        .get("scope")
        .and_then(|x| x.as_str())
        .unwrap_or("tenant");
    let user_id = payload.get("user_id").and_then(|x| x.as_str());
    let version = payload
        .get("key_version")
        .and_then(|x| x.as_u64())
        .unwrap_or(1);
    let kids = resolve_kids(scope, tenant_id, user_id, version)?;
    Ok(json!({
        "kms": KMS_PRODUCT,
        "bucket": BUCKET,
        "scope": scope,
        "kids": kids,
        "steps": STEPS,
        "status": "accepted_stub"
    }))
}

pub fn handle_erase_request(raw: &[u8]) -> Result<(u16, String), EraseError> {
    let v: Value = if raw.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(raw).map_err(|_| EraseError::InvalidJson)?
    };
    let tenant_id = v
        .get("tenant_id")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    if tenant_id.is_empty() {
        return Ok((
            400,
            json!({"type":"compliance.erase.error","error":"tenant_id_required"}).to_string(),
        ));
    }
    let plan = plan_erase(&v)?;
    Ok((
        200,
        json!({
            "type": "compliance.erase.done",
            "id": v.get("id"),
            "tenant_id": tenant_id,
            "payload": plan
        })
        .to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kids_and_steps_order() {
        assert_eq!(kid_tenant("t", 1), "tenant:t:v1");
        assert_eq!(STEPS[1], "shred_keys");
        assert!(STEPS.iter().position(|s| *s == "shred_keys").unwrap()
            < STEPS.iter().position(|s| *s == "delete_objects").unwrap());
        let kids = resolve_kids("user", "t", Some("u"), 2).unwrap();
        assert_eq!(kids[0], "tenant:t:user:u:v2");
    }

    #[test]
    fn erase_request_ok() {
        let raw = br#"{"id":"e1","tenant_id":"t","payload":{"scope":"tenant"}}"#;
        let (st, body) = handle_erase_request(raw).unwrap();
        assert_eq!(st, 200);
        assert!(body.contains("compliance.erase.done"));
        assert!(body.contains(KMS_PRODUCT));
    }
}
