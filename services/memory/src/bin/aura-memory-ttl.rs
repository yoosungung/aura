//! aura-memory-ttl JetStream worker.

use aura_js_worker::{run_jetstream_worker, Handler, WorkerConfig};
use aura_memory::handlers::handle_ttl_request;
use bytes::Bytes;

#[tokio::main]
async fn main() {
    let cfg = match WorkerConfig::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("aura-memory-ttl env: {e}");
            std::process::exit(2);
        }
    };
    let handler: Handler = Box::new(|raw: Bytes| {
        Box::pin(async move {
            match handle_ttl_request(&raw) {
                Ok((s, b)) => Ok((s, Bytes::from(b))),
                Err(e) => Ok((
                    500,
                    Bytes::from(format!(
                        r#"{{"error":"handler_error","detail":{}}}"#,
                        serde_json::to_string(&e).unwrap_or_default()
                    )),
                )),
            }
        })
    });
    if let Err(e) = run_jetstream_worker(cfg, handler).await {
        eprintln!("aura-memory-ttl fatal: {e}");
        std::process::exit(1);
    }
}
