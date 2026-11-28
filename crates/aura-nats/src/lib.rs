//! NATS client helpers for Aura platform services.
//!
//! mTLS policy mirrors `services/control/nats-tls.js` (ARCHITECTURE §9.2).
//! Live NATS is optional in unit tests — use `AURA_NATS_URL` for lab smoke.

use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_nats::ConnectOptions;
use bytes::Bytes;
use futures_util::StreamExt;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum NatsTlsError {
    #[error("mtls_required:{0}")]
    MtlsRequired(String),
    #[error("tls_material_incomplete:{0}")]
    Incomplete(String),
    #[error("nats_url_required")]
    UrlRequired,
    #[error("nats_plaintext_transport_forbidden")]
    PlaintextForbidden,
    #[error("tls_load:{0}")]
    Load(String),
}

#[derive(Debug, Clone)]
pub struct TlsMaterial {
    pub ca: Vec<u8>,
    pub cert: Vec<u8>,
    pub key: Vec<u8>,
}

/// Build TLS material; `require_mtls` defaults to true (Node parity).
pub fn build_nats_tls_options(
    ca: Option<Vec<u8>>,
    cert: Option<Vec<u8>>,
    key: Option<Vec<u8>>,
    require_mtls: bool,
) -> Result<TlsMaterial, NatsTlsError> {
    let mut missing = Vec::new();
    if ca.as_ref().map(|v| v.is_empty()).unwrap_or(true) {
        missing.push("ca");
    }
    if cert.as_ref().map(|v| v.is_empty()).unwrap_or(true) {
        missing.push("cert");
    }
    if key.as_ref().map(|v| v.is_empty()).unwrap_or(true) {
        missing.push("key");
    }
    if !missing.is_empty() {
        let joined = missing.join(",");
        if require_mtls {
            return Err(NatsTlsError::MtlsRequired(joined));
        }
        return Err(NatsTlsError::Incomplete(joined));
    }
    Ok(TlsMaterial {
        ca: ca.unwrap(),
        cert: cert.unwrap(),
        key: key.unwrap(),
    })
}

/// Reject cleartext-only transports when mTLS is required.
pub fn assert_nats_mtls_connect(
    url: &str,
    has_tls: bool,
    require_mtls: bool,
) -> Result<(), NatsTlsError> {
    if url.is_empty() {
        return Err(NatsTlsError::UrlRequired);
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("ws://") {
        return Err(NatsTlsError::PlaintextForbidden);
    }
    if require_mtls && !has_tls {
        return Err(NatsTlsError::MtlsRequired("connect_opts".into()));
    }
    Ok(())
}

pub fn load_tls_material_from_paths(
    ca_path: &Path,
    cert_path: &Path,
    key_path: &Path,
) -> Result<TlsMaterial, NatsTlsError> {
    let ca = std::fs::read(ca_path).map_err(|e| NatsTlsError::Load(format!("ca:{e}")))?;
    let cert = std::fs::read(cert_path).map_err(|e| NatsTlsError::Load(format!("cert:{e}")))?;
    let key = std::fs::read(key_path).map_err(|e| NatsTlsError::Load(format!("key:{e}")))?;
    build_nats_tls_options(Some(ca), Some(cert), Some(key), true)
}

fn parse_certs(pem: &[u8]) -> Result<Vec<CertificateDer<'static>>, NatsTlsError> {
    let mut reader = Cursor::new(pem);
    let certs: Result<Vec<_>, _> = rustls_pemfile::certs(&mut reader).collect();
    certs.map_err(|e| NatsTlsError::Load(format!("cert_parse:{e}")))
}

fn parse_key(pem: &[u8]) -> Result<PrivateKeyDer<'static>, NatsTlsError> {
    let mut reader = Cursor::new(pem);
    rustls_pemfile::private_key(&mut reader)
        .map_err(|e| NatsTlsError::Load(format!("key_parse:{e}")))?
        .ok_or_else(|| NatsTlsError::Load("key_parse:empty".into()))
}

/// Connect options with client mTLS (rustls).
pub fn connect_options_with_mtls(material: &TlsMaterial) -> Result<ConnectOptions, NatsTlsError> {
    let certs = parse_certs(&material.cert)?;
    let key = parse_key(&material.key)?;
    let mut root = rustls::RootCertStore::empty();
    for ca in parse_certs(&material.ca)? {
        root.add(ca)
            .map_err(|e| NatsTlsError::Load(format!("ca_add:{e}")))?;
    }
    let mut cfg = rustls::ClientConfig::builder()
        .with_root_certificates(root)
        .with_client_auth_cert(certs, key)
        .map_err(|e| NatsTlsError::Load(format!("client_cfg:{e}")))?;
    cfg.alpn_protocols = vec![b"nats".to_vec()];
    Ok(ConnectOptions::new().require_tls(true).tls_client_config(cfg))
}

/// Lab/dev connect without mTLS — only when explicitly allowed.
pub fn connect_options_insecure_for_lab() -> ConnectOptions {
    ConnectOptions::new()
}

pub async fn connect(
    url: &str,
    opts: ConnectOptions,
) -> Result<async_nats::Client, async_nats::ConnectError> {
    opts.connect(url).await
}

/// Core Request-Reply round-trip helper (Phase 0 smoke).
pub async fn core_rr_echo(
    client: &async_nats::Client,
    subject: &str,
    payload: Bytes,
    timeout: Duration,
) -> Result<Bytes, String> {
    let mut sub = client
        .subscribe(subject.to_string())
        .await
        .map_err(|e| e.to_string())?;
    let client2 = client.clone();
    let subject_owned = subject.to_string();
    let responder = tokio::spawn(async move {
        if let Some(msg) = sub.next().await {
            if let Some(reply) = msg.reply {
                let _ = client2.publish(reply, msg.payload).await;
            }
        }
    });
    // Give subscription a tick to register.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let response = tokio::time::timeout(timeout, client.request(subject_owned, payload))
        .await
        .map_err(|_| "rr_timeout".to_string())?
        .map_err(|e| e.to_string())?;
    let _ = responder.await;
    Ok(response.payload)
}

/// JetStream pull consumer echo (Phase 0 smoke).
pub async fn jetstream_pull_echo(
    client: &async_nats::Client,
    stream: &str,
    subject: &str,
    durable: &str,
    payload: Bytes,
    timeout: Duration,
) -> Result<Bytes, String> {
    let js = async_nats::jetstream::new(client.clone());
    let stream = js
        .get_or_create_stream(async_nats::jetstream::stream::Config {
            name: stream.into(),
            subjects: vec![subject.into()],
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;
    let consumer = stream
        .get_or_create_consumer(
            durable,
            async_nats::jetstream::consumer::pull::Config {
                durable_name: Some(durable.into()),
                ack_policy: async_nats::jetstream::consumer::AckPolicy::Explicit,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    js.publish(subject.to_string(), payload.clone())
        .await
        .map_err(|e| e.to_string())?
        .await
        .map_err(|e| e.to_string())?;

    let mut messages = consumer
        .messages()
        .await
        .map_err(|e| e.to_string())?;
    let msg = tokio::time::timeout(timeout, messages.next())
        .await
        .map_err(|_| "js_pull_timeout".to_string())?
        .ok_or_else(|| "js_pull_none".to_string())?
        .map_err(|e| e.to_string())?;
    let out = msg.payload.clone();
    msg.ack().await.map_err(|e| e.to_string())?;
    Ok(out)
}

/// Shared Arc wrapper for optional mTLS ConnectOptions builders.
pub type SharedTls = Arc<TlsMaterial>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mtls_required_when_material_missing() {
        let err = build_nats_tls_options(None, None, None, true).unwrap_err();
        assert_eq!(err, NatsTlsError::MtlsRequired("ca,cert,key".into()));
    }

    #[test]
    fn incomplete_when_mtls_optional() {
        let err = build_nats_tls_options(Some(b"ca".to_vec()), None, None, false).unwrap_err();
        assert_eq!(err, NatsTlsError::Incomplete("cert,key".into()));
    }

    #[test]
    fn accepts_full_material() {
        let m = build_nats_tls_options(
            Some(b"ca".to_vec()),
            Some(b"cert".to_vec()),
            Some(b"key".to_vec()),
            true,
        )
        .unwrap();
        assert_eq!(m.ca, b"ca");
    }

    #[test]
    fn rejects_http_and_ws() {
        assert_eq!(
            assert_nats_mtls_connect("http://nats:4222", true, true),
            Err(NatsTlsError::PlaintextForbidden)
        );
        assert_eq!(
            assert_nats_mtls_connect("ws://nats:4222", true, true),
            Err(NatsTlsError::PlaintextForbidden)
        );
    }

    #[test]
    fn require_tls_opts_when_mtls_on() {
        assert_eq!(
            assert_nats_mtls_connect("nats://nats:4222", false, true),
            Err(NatsTlsError::MtlsRequired("connect_opts".into()))
        );
        assert!(assert_nats_mtls_connect("nats://nats:4222", true, true).is_ok());
        assert!(assert_nats_mtls_connect("nats://nats:4222", false, false).is_ok());
    }
}
