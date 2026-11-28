//! aura-llm-gateway — HTTP surface (Phase 2B). Live provider HTTP = canary follow-up.
//! Function clients stay at services/llm-gateway/clients/client.js · client.py.

use aura_llm_gateway::{
    chat_completions, BillingStore, LlmRateLimiter, StubProvider, DEFAULT_BURST,
    DEFAULT_RATE_PER_SEC,
};
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

struct AppState {
    billing: BillingStore,
    tiers: HashMap<String, String>,
    rate: LlmRateLimiter,
}

#[tokio::main]
async fn main() {
    let mut tiers = HashMap::new();
    tiers.insert("simple".into(), "model-cheap".into());
    tiers.insert("medium".into(), "model-mid".into());
    tiers.insert("complex".into(), "model-strong".into());

    let now = Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    });

    let state = Arc::new(AppState {
        billing: BillingStore::default(),
        tiers,
        rate: LlmRateLimiter::new(DEFAULT_RATE_PER_SEC, DEFAULT_BURST, now),
    });

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/chat/completions", post(chat))
        .route("/v1/billing/usage", get(usage))
        .with_state(state);

    let addr: SocketAddr = "0.0.0.0:8080".parse().unwrap();
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn chat(
    State(st): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> (axum::http::StatusCode, Json<Value>) {
    let tenant = headers
        .get("x-aura-tenant-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let pin = headers
        .get("x-aura-route-pin")
        .and_then(|v| v.to_str().ok());
    let providers: Vec<Box<dyn aura_llm_gateway::ChatProvider>> =
        vec![Box::new(StubProvider::ok("stub", "stub"))];
    let out = chat_completions(
        tenant,
        &body,
        pin,
        &st.tiers,
        &providers,
        &st.billing,
        Some(&st.rate),
        None,
    );
    (
        axum::http::StatusCode::from_u16(out.status)
            .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
        Json(out.body),
    )
}

async fn usage(
    State(st): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> (axum::http::StatusCode, Json<Value>) {
    let tenant = headers
        .get("x-aura-tenant-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if tenant.is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"error":"tenant_id_required"})),
        );
    }
    (axum::http::StatusCode::OK, Json(st.billing.usage(tenant)))
}
