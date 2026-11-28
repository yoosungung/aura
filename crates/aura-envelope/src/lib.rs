//! Aura common event envelope (ARCHITECTURE §8).
//!
//! Wire fields are invariant across Node/Python/Rust. Do not rename keys.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

/// NATS payload hard cap (ARCHITECTURE §8): 256 KiB.
pub const MAX_NATS_PAYLOAD_BYTES: usize = 262_144;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub event_type: String,
    pub tenant_id: String,
    pub occurred_at: DateTime<Utc>,
    #[serde(default)]
    pub payload: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_ref: Option<Value>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EnvelopeError {
    #[error("json: {0}")]
    Json(String),
    #[error("missing_field:{0}")]
    MissingField(&'static str),
    #[error("empty_field:{0}")]
    EmptyField(&'static str),
    #[error("payload_too_large:{0}")]
    PayloadTooLarge(usize),
}

impl Envelope {
    pub fn new(
        event_type: impl Into<String>,
        tenant_id: impl Into<String>,
        payload: Value,
    ) -> Self {
        Self {
            id: Uuid::now_v7(),
            event_type: event_type.into(),
            tenant_id: tenant_id.into(),
            occurred_at: Utc::now(),
            payload,
            content_ref: None,
        }
    }

    pub fn validate(&self) -> Result<(), EnvelopeError> {
        if self.event_type.trim().is_empty() {
            return Err(EnvelopeError::EmptyField("type"));
        }
        if self.tenant_id.trim().is_empty() {
            return Err(EnvelopeError::EmptyField("tenant_id"));
        }
        Ok(())
    }

    pub fn to_vec(&self) -> Result<Vec<u8>, EnvelopeError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|e| EnvelopeError::Json(e.to_string()))?;
        if bytes.len() > MAX_NATS_PAYLOAD_BYTES {
            return Err(EnvelopeError::PayloadTooLarge(bytes.len()));
        }
        Ok(bytes)
    }

    pub fn from_slice(bytes: &[u8]) -> Result<Self, EnvelopeError> {
        if bytes.len() > MAX_NATS_PAYLOAD_BYTES {
            return Err(EnvelopeError::PayloadTooLarge(bytes.len()));
        }
        let env: Self =
            serde_json::from_slice(bytes).map_err(|e| EnvelopeError::Json(e.to_string()))?;
        env.validate()?;
        Ok(env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_matches_architecture_shape() {
        let raw = r#"{
          "id": "01930000-0000-7000-8000-000000000001",
          "type": "memory.candidates",
          "tenant_id": "tenant-a",
          "occurred_at": "2026-11-17T00:00:00Z",
          "payload": {"n": 1},
          "content_ref": null
        }"#;
        let env = Envelope::from_slice(raw.as_bytes()).expect("parse");
        assert_eq!(env.event_type, "memory.candidates");
        assert_eq!(env.tenant_id, "tenant-a");
        assert_eq!(env.payload, json!({"n": 1}));
        assert!(env.content_ref.is_none());

        let out = env.to_vec().expect("serialize");
        let again = Envelope::from_slice(&out).expect("reparse");
        assert_eq!(again.event_type, env.event_type);
        assert_eq!(again.tenant_id, env.tenant_id);
        assert_eq!(again.payload, env.payload);
    }

    #[test]
    fn rejects_empty_tenant() {
        let env = Envelope {
            id: Uuid::nil(),
            event_type: "x".into(),
            tenant_id: "  ".into(),
            occurred_at: Utc::now(),
            payload: Value::Null,
            content_ref: None,
        };
        assert_eq!(env.validate(), Err(EnvelopeError::EmptyField("tenant_id")));
    }

    #[test]
    fn rejects_oversized_payload() {
        let huge = vec![b'x'; MAX_NATS_PAYLOAD_BYTES + 1];
        assert!(matches!(
            Envelope::from_slice(&huge),
            Err(EnvelopeError::PayloadTooLarge(_))
        ));
    }

    #[test]
    fn new_sets_type_and_tenant() {
        let env = Envelope::new("memory.stored", "t1", json!({}));
        assert_eq!(env.event_type, "memory.stored");
        assert_eq!(env.tenant_id, "t1");
        env.validate().unwrap();
    }
}
