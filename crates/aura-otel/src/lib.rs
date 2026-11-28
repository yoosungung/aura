//! OTel attribute allowlist + secret masking (ARCHITECTURE §9.2).
//! Parity with `services/control/secrets-mask.js` and `services/otel/attributes.js`.

use regex::Regex;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::OnceLock;
use thiserror::Error;

pub const MASK: &str = "***";

pub const REQUIRED_CONTEXT_KEYS: [&str; 3] =
    ["aura.tenant_id", "aura.session_id", "aura.run_id"];

fn sensitive_key() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^(secrets?|password|passwd|token|api[_-]?key|authorization|credential|private[_-]?key|client[_-]?secret)$",
        )
        .expect("sensitive_key")
    })
}

fn sensitive_value() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\b(postgres(ql)?://[^\s"']+|Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9_-]{8,})\b"#,
        )
        .expect("sensitive_value")
    })
}

fn allowed_keys() -> &'static HashSet<&'static str> {
    static KEYS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    KEYS.get_or_init(|| {
        HashSet::from([
            "aura.tenant_id",
            "aura.session_id",
            "aura.run_id",
            "faas.name",
            "aura.function.name",
            "aura.rpc.subject",
            "messaging.system.name",
            "messaging.operation.name",
            "messaging.destination.name",
            "db.system.name",
            "db.operation.name",
            "db.query.summary",
            "db.query.text",
            "server.address",
            "server.port",
            "error.type",
        ])
    })
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OtelError {
    #[error("missing_context:{0}")]
    MissingContext(&'static str),
    #[error("disallowed_attr:{0}")]
    DisallowedAttr(String),
    #[error("plaintext_secret_in_attributes")]
    PlaintextSecret,
}

/// Deep-clone JSON with sensitive keys replaced by MASK (Node maskSecrets parity).
pub fn mask_secrets(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(mask_secrets).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                if sensitive_key().is_match(k) {
                    out.insert(k.clone(), Value::String(MASK.into()));
                } else {
                    out.insert(k.clone(), mask_secrets(v));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

pub fn mask_secrets_for_log(value: &Value) -> String {
    mask_secrets(value).to_string()
}

/// Keep allowlisted scalar keys only; run mask_secrets first.
pub fn sanitize_attributes(attrs: &Map<String, Value>) -> Map<String, Value> {
    let masked = match mask_secrets(&Value::Object(attrs.clone())) {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    let mut out = Map::new();
    for (k, v) in masked {
        if !allowed_keys().contains(k.as_str()) {
            continue;
        }
        match v {
            Value::Null => continue,
            Value::Object(_) | Value::Array(_) => continue,
            scalar => {
                out.insert(k, scalar);
            }
        }
    }
    out
}

pub fn assert_safe_attributes(attrs: &Map<String, Value>) -> Result<Map<String, Value>, OtelError> {
    for key in attrs.keys() {
        if !allowed_keys().contains(key.as_str()) {
            return Err(OtelError::DisallowedAttr(key.clone()));
        }
    }
    let clean = sanitize_attributes(attrs);
    for &key in &REQUIRED_CONTEXT_KEYS {
        match clean.get(key) {
            None | Some(Value::Null) => return Err(OtelError::MissingContext(key)),
            Some(Value::String(s)) if s.is_empty() => {
                return Err(OtelError::MissingContext(key));
            }
            Some(_) => {}
        }
    }
    let blob = Value::Object(clean.clone()).to_string();
    if sensitive_value().is_match(&blob) {
        return Err(OtelError::PlaintextSecret);
    }
    Ok(clean)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mask_secrets_parity_with_node_fixture() {
        let nested = json!({
            "tenant_id": "t1",
            "api_key": "sk-live-xyz",
            "cfg": { "token": "bearer-abc", "ok": 1 },
            "secrets": { "db": "postgres://u:p@h" },
            "nested": { "authorization": "Basic x", "label": "safe" },
            "password": "hunter2",
        });
        let masked = mask_secrets(&nested);
        assert_eq!(masked["api_key"], MASK);
        assert_eq!(masked["password"], MASK);
        assert_eq!(masked["secrets"], MASK);
        assert_eq!(masked["cfg"]["token"], MASK);
        assert_eq!(masked["cfg"]["ok"], 1);
        assert_eq!(masked["nested"]["authorization"], MASK);
        assert_eq!(masked["nested"]["label"], "safe");
        assert_eq!(masked["tenant_id"], "t1");
        assert_ne!(nested["api_key"], MASK);

        let log = mask_secrets_for_log(&json!({"client_secret":"x","count":2}));
        assert!(log.contains(MASK));
        assert!(!log.contains('x'));

        assert_eq!(mask_secrets(&Value::Null), Value::Null);
        assert_eq!(
            mask_secrets(&json!([{"token":"t"}])),
            json!([{"token": MASK}])
        );
    }

    #[test]
    fn sanitize_drops_disallowed_and_requires_context() {
        let mut attrs = Map::new();
        attrs.insert("aura.tenant_id".into(), json!("t1"));
        attrs.insert("aura.session_id".into(), json!("s1"));
        attrs.insert("aura.run_id".into(), json!("r1"));
        attrs.insert("api_key".into(), json!("secret"));
        attrs.insert("db.query.parameter".into(), json!("nope"));

        let clean = sanitize_attributes(&attrs);
        assert_eq!(clean.get("aura.tenant_id").unwrap(), "t1");
        assert!(clean.get("api_key").is_none());
        assert!(clean.get("db.query.parameter").is_none());

        assert!(assert_safe_attributes(&attrs).is_err()); // disallowed keys on input

        let mut ok = Map::new();
        ok.insert("aura.tenant_id".into(), json!("t1"));
        ok.insert("aura.session_id".into(), json!("s1"));
        ok.insert("aura.run_id".into(), json!("r1"));
        ok.insert("faas.name".into(), json!("aura-memory-recall"));
        assert!(assert_safe_attributes(&ok).is_ok());
    }
}
