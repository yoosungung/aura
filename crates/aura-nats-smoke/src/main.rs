//! Phase 0 smoke: Core RR echo + JetStream pull echo.
//!
//! Lab: `AURA_NATS_URL=nats://127.0.0.1:4222 cargo run -p aura-nats-smoke`
//! Without URL, prints usage and exits 0 (CI does not require live NATS).

use std::env;
use std::time::Duration;

use aura_envelope::Envelope;
use aura_nats::{
    assert_nats_mtls_connect, connect, connect_options_insecure_for_lab, core_rr_echo,
    jetstream_pull_echo,
};
use bytes::Bytes;
use serde_json::json;

#[tokio::main]
async fn main() {
    let url = env::var("AURA_NATS_URL").unwrap_or_default();
    if url.is_empty() {
        println!("aura-nats-smoke: SKIP live (set AURA_NATS_URL for lab)");
        println!("unit gates cover mTLS policy + envelope; see check-service-rust-phase0.sh");
        return;
    }

    // Lab default: plaintext NATS (OrbStack/dev). Production must set AURA_NATS_REQUIRE_MTLS=1
    // and supply cert paths via aura-nats helpers.
    let require_mtls = env::var("AURA_NATS_REQUIRE_MTLS").ok().as_deref() == Some("1");
    if let Err(e) = assert_nats_mtls_connect(&url, !require_mtls, require_mtls) {
        // when require_mtls=false, has_tls unused; when true, lab must wire certs (Phase 1+)
        eprintln!("aura-nats-smoke: mtls policy: {e}");
        if require_mtls {
            std::process::exit(2);
        }
    }

    let opts = connect_options_insecure_for_lab();
    let client = match connect(&url, opts).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("aura-nats-smoke: connect failed: {e}");
            std::process::exit(1);
        }
    };

    let env = Envelope::new(
        "smoke.echo",
        "tenant-smoke",
        json!({"phase": 0, "kind": "core_rr"}),
    );
    let payload = Bytes::from(env.to_vec().expect("envelope"));
    let rr = core_rr_echo(
        &client,
        "aura.rpc.smoke.echo",
        payload.clone(),
        Duration::from_secs(5),
    )
    .await
    .expect("core rr");
    assert_eq!(rr, payload, "core rr payload mismatch");
    println!("OK: Core RR echo");

    let js_payload = Bytes::from(
        Envelope::new(
            "smoke.echo",
            "tenant-smoke",
            json!({"phase": 0, "kind": "js_pull"}),
        )
        .to_vec()
        .expect("envelope"),
    );
    let got = jetstream_pull_echo(
        &client,
        "AURA_SMOKE",
        "aura.tasks.smoke.rust",
        "aura_smoke_rust",
        js_payload.clone(),
        Duration::from_secs(10),
    )
    .await
    .expect("js pull");
    assert_eq!(got, js_payload, "js pull payload mismatch");
    println!("OK: JetStream pull echo");
    println!("aura-nats-smoke: PASS");
}
