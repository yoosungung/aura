//! aura-memory-capture — JetStream Deployment binary (inline extract→embed→store stub).

use aura_js_worker::{run_jetstream_worker, Handler, WorkerConfig};
use aura_memory::capture::handle_capture_request;
use bytes::Bytes;

#[tokio::main]
async fn main() {
    let cfg = match WorkerConfig::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("aura-memory-capture env: {e}");
            std::process::exit(2);
        }
    };

    let handler: Handler = Box::new(|raw: Bytes| {
        Box::pin(async move {
            match handle_capture_request(&raw) {
                Ok((status, body)) => Ok((status, Bytes::from(body))),
                Err(e) => {
                    let body = serde_json::json!({
                        "type": "memory.capture.error",
                        "error": e.to_string(),
                    })
                    .to_string();
                    Ok((400, Bytes::from(body)))
                }
            }
        })
    });

    if let Err(e) = run_jetstream_worker(cfg, handler).await {
        eprintln!("aura-memory-capture fatal: {e}");
        std::process::exit(1);
    }
}
