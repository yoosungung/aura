//! aura-control-resolve — HTTP RPC for rpc-bridge (StubPooler until live sqlx).

use aura_control::{resolve_with_pooler, StubPooler};
use axum::body::Bytes;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(|| async { "ok" }))
        .route("/", post(rpc))
        .route("/rpc", post(rpc));

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    eprintln!("aura-control-resolve listening on {addr}");
    axum::serve(listener, app).await.expect("serve");
}

async fn rpc(body: Bytes) -> (StatusCode, Json<Value>) {
    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "type": "control.resolve.error",
                    "ok": false,
                    "error": "invalid_json",
                    "detail": e.to_string(),
                    "subject": "aura.rpc.control.resolve"
                })),
            );
        }
    };

    // Lab: optional stub source via env AURA_RESOLVE_STUB_SOURCE=json
    let pooler = if let Ok(raw) = std::env::var("AURA_RESOLVE_STUB_SOURCE") {
        match serde_json::from_str::<Value>(&raw) {
            Ok(src) => StubPooler::with_source(src),
            Err(_) => StubPooler::empty(),
        }
    } else {
        StubPooler::empty()
    };

    match resolve_with_pooler(&req, &pooler) {
        Ok(out) => {
            let ok = out.get("type").and_then(|t| t.as_str()) == Some("control.resolve.done");
            let mut body = out;
            if let Some(obj) = body.as_object_mut() {
                obj.insert("ok".into(), json!(ok));
            }
            let status = if ok {
                StatusCode::OK
            } else {
                StatusCode::BAD_REQUEST
            };
            (status, Json(body))
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "type": "control.resolve.error",
                "ok": false,
                "error": e,
                "subject": "aura.rpc.control.resolve"
            })),
        ),
    }
}
