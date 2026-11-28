//! aura-control-admin stub HTTP (Phase 3). Live Pooler = canary follow-up.

use aura_control::{
    admin_list_tenants_stub, admin_post_audit_stub, allowed_admin_paths,
};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/tenants", get(|| async {
            let (st, body) = admin_list_tenants_stub();
            (
                axum::http::StatusCode::from_u16(st).unwrap(),
                Json(body),
            )
        }))
        .route("/v1/audit", post(post_audit))
        .route("/v1/paths", get(|| async {
            let paths: Vec<_> = allowed_admin_paths().into_iter().collect();
            Json(json!({ "paths": paths }))
        }));

    let addr: SocketAddr = "0.0.0.0:8080".parse().unwrap();
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn post_audit(
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> (axum::http::StatusCode, Json<Value>) {
    let tenant = headers
        .get("x-aura-tenant-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let actor = body
        .get("actor")
        .and_then(|v| v.as_str())
        .unwrap_or("ops");
    let action = body
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let reason = body.get("reason").and_then(|v| v.as_str());
    let (st, out) = admin_post_audit_stub(tenant, actor, action, reason);
    (
        axum::http::StatusCode::from_u16(st).unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
        Json(out),
    )
}
