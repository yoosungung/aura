//! aura-nats-rpc-bridge (Rust) — same queue-group / subjects / env as Node bridge.

use std::env;

use aura_nats_rpc_bridge::{
    run_bridge, DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_MAX_INFLIGHT, DEFAULT_ROUTER_URL, QUEUE_GROUP,
};

#[tokio::main]
async fn main() {
    let nats_url = env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    let router_url =
        env::var("FISSION_ROUTER_URL").unwrap_or_else(|_| DEFAULT_ROUTER_URL.to_string());
    let queue = env::var("RPC_QUEUE").unwrap_or_else(|_| QUEUE_GROUP.to_string());
    let max_inflight = env::var("RPC_MAX_INFLIGHT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_MAX_INFLIGHT);
    let fetch_timeout_ms = env::var("RPC_FETCH_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_FETCH_TIMEOUT_MS);

    if let Err(e) = run_bridge(
        &nats_url,
        &router_url,
        &queue,
        max_inflight,
        fetch_timeout_ms,
    )
    .await
    {
        eprintln!("nats-rpc-bridge fatal: {e}");
        std::process::exit(1);
    }
}
