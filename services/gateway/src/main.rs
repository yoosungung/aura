//! aura-gateway — HTTP surface (Phase 2A). Live NATS stream subscribe = lab/canary.

use aura_gateway::{
    authorize_ws, handle_submit_http, Limits, MemoryKv, Principal, RunRegistry,
    TenantRateLimiter,
};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;

struct AppState {
    registry: RunRegistry,
    limiter: TenantRateLimiter,
}

#[tokio::main]
async fn main() {
    let kv = Arc::new(MemoryKv::new());
    let now = Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    });
    let state = Arc::new(AppState {
        registry: RunRegistry::new(),
        limiter: TenantRateLimiter::new(kv, Limits::default(), now),
    });

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/agent/invoke", post(invoke))
        .route("/v1/runs/{run_id}/events", get(sse_authorize))
        .route("/v1/runs/{run_id}/ws", get(ws_authorize))
        .with_state(state);

    let addr: SocketAddr = "0.0.0.0:8080".parse().unwrap();
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    tracing::info!("aura-gateway listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}

fn principal_from(headers: &axum::http::HeaderMap) -> Principal {
    Principal {
        id: headers
            .get("x-aura-principal-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string(),
        tenant_id: headers
            .get("x-aura-tenant-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string(),
    }
}

async fn invoke(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> (axum::http::StatusCode, Json<Value>) {
    let principal = principal_from(&headers);
    // Lab/dev: publish is a no-op sink until NATS is wired in canary.
    let (status, out) = handle_submit_http(
        &body,
        &principal,
        &state.registry,
        &state.limiter,
        |_subject, _task| Ok(()),
    )
    .await;
    let body = if out.get("error").is_some() || status == 202 {
        out
    } else {
        json!({ "error": "submit_failed" })
    };
    (
        axum::http::StatusCode::from_u16(status)
            .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
}

/// Authorize-only SSE gate (403/404). Live NATS frame pump = canary follow-up.
async fn sse_authorize(
    State(state): State<Arc<AppState>>,
    Path(run_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> (axum::http::StatusCode, Json<Value>) {
    let principal = principal_from(&headers);
    match authorize_ws(&run_id, &principal, &state.registry) {
        Ok(subject) => (
            axum::http::StatusCode::OK,
            Json(json!({
                "ok": true,
                "content_type": "text/event-stream",
                "subject": subject,
                "note": "stream_pump_deferred_to_canary"
            })),
        ),
        Err(e) => (
            axum::http::StatusCode::from_u16(e.status)
                .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({ "error": e.message })),
        ),
    }
}

async fn ws_authorize(
    State(state): State<Arc<AppState>>,
    Path(run_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> (axum::http::StatusCode, Json<Value>) {
    let principal = principal_from(&headers);
    match authorize_ws(&run_id, &principal, &state.registry) {
        Ok(subject) => (
            axum::http::StatusCode::OK,
            Json(json!({ "ok": true, "subject": subject })),
        ),
        Err(e) => (
            axum::http::StatusCode::from_u16(e.status)
                .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({ "error": e.message })),
        ),
    }
}
