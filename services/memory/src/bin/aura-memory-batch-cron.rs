//! CronJob publisher — one JetStream envelope then exit (Node batch-cron-publish.js parity).

use aura_memory::batch_payload::build_batch_payload;
use aura_nats::{connect, connect_options_insecure_for_lab};
use bytes::Bytes;
use chrono::Utc;

#[tokio::main]
async fn main() {
    let nats_url =
        std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    let subject = match std::env::var("TASK_SUBJECT") {
        Ok(s) if !s.is_empty() => s,
        _ => {
            eprintln!("TASK_SUBJECT required");
            std::process::exit(1);
        }
    };
    let tenant_id = std::env::var("TENANT_ID")
        .unwrap_or_else(|_| "00000000-0000-0000-0000-000000000000".into());

    let envelope = if let Ok(raw) = std::env::var("PAYLOAD_JSON") {
        if !raw.trim().is_empty() {
            let day = Utc::now().format("%Y-%m-%d").to_string();
            let id = std::env::var("ENVELOPE_ID").unwrap_or_else(|_| {
                format!(
                    "{}:{}:{}",
                    subject.rsplit('.').next().unwrap_or("batch"),
                    tenant_id,
                    day
                )
            });
            let payload: serde_json::Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("PAYLOAD_JSON: {e}");
                    std::process::exit(1);
                }
            };
            serde_json::json!({
                "id": id,
                "type": format!("memory.{}", subject.rsplit('.').next().unwrap_or("batch")),
                "tenant_id": tenant_id,
                "occurred_at": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "payload": payload
            })
        } else {
            match build_batch_payload(&subject, &tenant_id, Utc::now()) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
        }
    } else {
        match build_batch_payload(&subject, &tenant_id, Utc::now()) {
            Ok(mut v) => {
                if let Ok(id) = std::env::var("ENVELOPE_ID") {
                    v["id"] = serde_json::json!(id);
                }
                v
            }
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
    };

    let client = match connect(&nats_url, connect_options_insecure_for_lab()).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("nats connect: {e}");
            std::process::exit(1);
        }
    };
    let js = async_nats::jetstream::new(client);
    let body = Bytes::from(envelope.to_string());
    if let Err(e) = js.publish(subject.clone(), body).await {
        eprintln!("publish: {e}");
        std::process::exit(1);
    }
    let id = envelope.get("id").and_then(|v| v.as_str()).unwrap_or("");
    eprintln!("published {subject} id={id}");
}
