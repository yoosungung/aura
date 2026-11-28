//! aura-compliance-erase JetStream worker.

use aura_compliance_erase::handle_erase_request;
use aura_js_worker::{run_jetstream_worker, Handler, WorkerConfig};
use bytes::Bytes;

#[tokio::main]
async fn main() {
    let cfg = match WorkerConfig::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("aura-compliance-erase env: {e}");
            std::process::exit(2);
        }
    };
    let handler: Handler = Box::new(|raw: Bytes| {
        Box::pin(async move {
            match handle_erase_request(&raw) {
                Ok((s, b)) => Ok((s, Bytes::from(b))),
                Err(e) => Ok((
                    400,
                    Bytes::from(
                        serde_json::json!({
                            "type": "compliance.erase.error",
                            "error": e.to_string()
                        })
                        .to_string(),
                    ),
                )),
            }
        })
    });
    if let Err(e) = run_jetstream_worker(cfg, handler).await {
        eprintln!("aura-compliance-erase fatal: {e}");
        std::process::exit(1);
    }
}
