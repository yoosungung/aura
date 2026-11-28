//! aura-nats-task-bridge (Rust) — same durables / AckWait / env as Node bridge.

use std::env;

use aura_nats_task_bridge::{
    desired_ack_wait_ms, run_task_bridge, TaskBridgeConfig, DEFAULT_FETCH_TIMEOUT_MS,
    DEFAULT_MAX_DELIVER, DEFAULT_MAX_INFLIGHT, DEFAULT_ROUTER_URL, DEFAULT_STREAM,
    DEFAULT_WORKING_INTERVAL_MS,
};

#[tokio::main]
async fn main() {
    let nats_url = env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    let router_url =
        env::var("FISSION_ROUTER_URL").unwrap_or_else(|_| DEFAULT_ROUTER_URL.to_string());
    let stream = env::var("TASK_STREAM").unwrap_or_else(|_| DEFAULT_STREAM.to_string());
    let max_inflight = env::var("TASK_MAX_INFLIGHT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_MAX_INFLIGHT);
    let fetch_timeout_ms = env::var("TASK_FETCH_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_FETCH_TIMEOUT_MS);
    let ack_wait_ms = env::var("TASK_ACK_WAIT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| desired_ack_wait_ms(fetch_timeout_ms));
    let max_deliver = env::var("TASK_MAX_DELIVER")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_MAX_DELIVER);
    let working_interval_ms = env::var("TASK_WORKING_INTERVAL_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_WORKING_INTERVAL_MS);

    if let Err(e) = run_task_bridge(TaskBridgeConfig {
        nats_url,
        router_url,
        stream,
        max_inflight,
        fetch_timeout_ms,
        ack_wait_ms,
        max_deliver,
        working_interval_ms,
    })
    .await
    {
        eprintln!("nats-task-bridge fatal: {e}");
        std::process::exit(1);
    }
}
