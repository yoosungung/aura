//! aura-memory-object-gc — CronJob one-shot (no always-on Deployment).

use aura_memory::batch_payload::build_batch_payload;
use aura_memory::handlers::handle_object_gc_request;
use chrono::Utc;

fn main() {
    let tenant_id = std::env::var("TENANT_ID")
        .unwrap_or_else(|_| "00000000-0000-0000-0000-000000000000".into());
    let envelope =
        match build_batch_payload("aura.tasks.memory.object_gc", &tenant_id, Utc::now()) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("aura-memory-object-gc payload: {e}");
                std::process::exit(2);
            }
        };
    let raw = envelope.to_string();
    match handle_object_gc_request(raw.as_bytes()) {
        Ok((status, body)) if (200..400).contains(&status) => {
            eprintln!("aura-memory-object-gc ok status={status} body={body}");
        }
        Ok((status, body)) => {
            eprintln!("aura-memory-object-gc failed status={status} body={body}");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("aura-memory-object-gc error: {e}");
            std::process::exit(1);
        }
    }
}
