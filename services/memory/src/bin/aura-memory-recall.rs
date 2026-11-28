//! aura-memory-recall — HTTP RPC for rpc-bridge (Deployment Service).

use aura_memory::handlers::handle_recall_request;
use axum::body::Bytes;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Router, response::IntoResponse};
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
    eprintln!("aura-memory-recall listening on {addr}");
    axum::serve(listener, app).await.expect("serve");
}

async fn rpc(body: Bytes) -> impl IntoResponse {
    match handle_recall_request(&body) {
        Ok((status, json)) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            json,
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            format!(r#"{{"error":"handler_error","detail":{}}}"#, serde_json::to_string(&e).unwrap_or_default()),
        ),
    }
}
