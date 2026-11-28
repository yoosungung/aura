//! Node `gateway.selftest.js` parity — cluster-free (Phase 2A TDD).

use crate::*;
use serde_json::json;
use std::sync::Arc;

fn principal(id: &str, tenant: &str) -> Principal {
    Principal {
        id: id.into(),
        tenant_id: tenant.into(),
    }
}

fn limiter(kv: Arc<MemoryKv>, limits: Limits, now: u64) -> TenantRateLimiter {
    TenantRateLimiter::new(kv, limits, Arc::new(move || now))
}

#[test]
fn no_pg_in_gateway_crate() {
    let lib = include_str!("lib.rs");
    let rate = include_str!("rate_limit.rs");
    let main = include_str!("main.rs");
    for src in [lib, rate, main] {
        assert!(!src.contains("sqlx"));
        assert!(!src.contains("set_config"));
        assert!(!src.contains("AURA_DATABASE_HOST"));
    }
}

#[test]
fn run_id_uuidv7_and_exact_stream_subject() {
    let id = issue_run_id();
    assert!(is_uuid_v7(&id));
    assert_ne!(issue_run_id(), id);
    assert_eq!(
        build_stream_subject("019a0000-0000-7000-8000-000000000001").unwrap(),
        "aura.stream.019a0000-0000-7000-8000-000000000001"
    );
    assert_eq!(
        build_stream_subject("abc*").unwrap_err().message,
        "run_id_invalid"
    );
    let err = assert_exact_stream_subject(
        "aura.stream.>",
        "019a0000-0000-7000-8000-000000000001",
    )
    .unwrap_err();
    assert!(
        err.message == "stream_subject_mismatch" || err.message == "stream_wildcard_forbidden"
    );
}

#[test]
fn validate_principal_and_defaults() {
    assert!(validate_principal(None).is_err());
    assert!(validate_principal(Some(&principal("u", ""))).is_err());
    assert!(validate_principal(Some(&principal("u", "t"))).is_ok());
    assert_eq!(DEFAULT_RATE_PER_SEC, 10.0);
    assert_eq!(DEFAULT_BURST, 30.0);
    assert_eq!(DEFAULT_MAX_INFLIGHT, 20);
    assert!(STREAM_FRAME_TYPES.contains(&"token"));
    assert!(STREAM_FRAME_TYPES.contains(&"run.completed"));
}

#[tokio::test]
async fn submit_publish_and_identifiers_only() {
    let reg = RunRegistry::new();
    let kv = Arc::new(MemoryKv::new());
    let lim = limiter(kv, Limits::default(), 1_700_000_000_000);
    let p = principal("user-1", "tenant-a");
    let mut published = Vec::new();
    let out = submit_agent_invoke(
        &json!({
            "agent":"demo","version":"1.0.0","session_id":"sess-1","stream":true,
            "input":{"text":"hello"}
        }),
        &p,
        &reg,
        &lim,
        |subject, task| {
            published.push((subject, task));
            Ok(())
        },
    )
    .await
    .unwrap();
    assert!(is_uuid_v7(&out.run_id));
    assert!(out.stream);
    assert_eq!(out.stream_subject, build_stream_subject(&out.run_id).unwrap());
    assert_eq!(published.len(), 1);
    assert_eq!(published[0].0, TASK_AGENT_INVOKE);
    assert_eq!(published[0].1["run_id"], out.run_id);

    let err = submit_agent_invoke(
        &json!({"agent":"a","version":"1","bundle":{"uri":"x"}}),
        &p,
        &reg,
        &lim,
        |_s, _t| Ok(()),
    )
    .await
    .unwrap_err();
    assert_eq!(err.message, "identifiers_only");
}

#[tokio::test]
async fn sse_ws_authorize_403_404_and_frames() {
    let reg = RunRegistry::new();
    let kv = Arc::new(MemoryKv::new());
    let lim = limiter(kv, Limits::default(), 1_700_000_000_000);
    let p = principal("user-1", "tenant-a");
    let other = principal("user-2", "tenant-a");
    let cross = principal("user-1", "tenant-b");

    let accepted = submit_agent_invoke(
        &json!({"agent":"demo","version":"1.0.0"}),
        &p,
        &reg,
        &lim,
        |_s, _t| Ok(()),
    )
    .await
    .unwrap();

    let (bridge, frames) = open_stream_bridge(
        &accepted.run_id,
        &p,
        &reg,
        Some(&lim),
        |subject, sink| {
            assert_eq!(subject, build_stream_subject(&accepted.run_id).unwrap());
            sink.push(json!({"type":"run.started","run_id": accepted.run_id}));
            sink.push(json!({"type":"token","text":"hi"}));
            sink.push(json!({"type":"run.completed"}));
        },
    )
    .await
    .unwrap();
    assert_eq!(bridge.subject, build_stream_subject(&accepted.run_id).unwrap());
    assert_eq!(
        frames
            .iter()
            .map(|f| f["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["run.started", "token", "run.completed"]
    );
    for t in frames.iter().filter_map(|f| f["type"].as_str()) {
        assert!(STREAM_FRAME_TYPES.contains(&t));
    }

    let forbid = open_stream_bridge(&accepted.run_id, &other, &reg, None, |_, _| {})
        .await
        .unwrap_err();
    assert_eq!(forbid.status, 403);
    assert_eq!(forbid.message, "principal_forbidden");

    let tenant_forbid = open_stream_bridge(&accepted.run_id, &cross, &reg, None, |_, _| {})
        .await
        .unwrap_err();
    assert_eq!(tenant_forbid.status, 403);

    let missing = open_stream_bridge(
        "019a0000-0000-7000-8000-00000000dead",
        &p,
        &reg,
        None,
        |_, _| {},
    )
    .await
    .unwrap_err();
    assert_eq!(missing.status, 404);
    assert_eq!(missing.message, "run_not_found");

    let ws_ok = authorize_ws(&accepted.run_id, &p, &reg).unwrap();
    assert!(ws_ok.starts_with("aura.stream."));
    assert_eq!(authorize_ws(&accepted.run_id, &other, &reg).unwrap_err().status, 403);

    let sse_line = format_sse_frame(&json!({"type":"token","text":"x"}));
    assert!(sse_line.starts_with("data: "));
    assert!(sse_line.ends_with("\n\n"));
    let payload: Value =
        serde_json::from_str(sse_line.trim_start_matches("data: ").trim()).unwrap();
    assert_eq!(payload["type"], "token");
    assert_eq!(payload["text"], "x");

    let sse = handle_sse_http(
        &accepted.run_id,
        &p,
        &reg,
        None,
        |_subject, sink| {
            sink.push(json!({"type":"token","text":"ok"}));
        },
    )
    .await;
    assert_eq!(sse.status, 200);
    assert_eq!(sse.content_type, "text/event-stream");
    assert!(sse.frames.iter().any(|f| f.contains("\"type\":\"token\"")));

    let deny = handle_sse_http(&accepted.run_id, &other, &reg, None, |_, _| {}).await;
    assert_eq!(deny.status, 403);
}

#[tokio::test]
async fn fair_queue_noisy_quiet_and_release() {
    let limits = Limits {
        rate_per_sec: 1.0,
        burst: 1.0,
        max_inflight: 1,
    };
    let kv = Arc::new(MemoryKv::new());
    let t = 1_700_000_000_000u64;
    let lim = limiter(Arc::clone(&kv), limits.clone(), t);
    let noisy = principal("noisy", "tenant-noisy");
    let quiet = principal("quiet", "tenant-quiet");
    let reg_a = RunRegistry::new();
    let reg_b = RunRegistry::new();

    let mut pubs_a = 0u32;
    let ok_a = submit_agent_invoke(
        &json!({"agent":"demo","version":"1.0.0"}),
        &noisy,
        &reg_a,
        &lim,
        |_s, _t| {
            pubs_a += 1;
            Ok(())
        },
    )
    .await
    .unwrap();
    assert_eq!(pubs_a, 1);

    let mut must_not = false;
    let limited = submit_agent_invoke(
        &json!({"agent":"demo","version":"1.0.0"}),
        &noisy,
        &reg_a,
        &lim,
        |_s, _t| {
            must_not = true;
            Ok(())
        },
    )
    .await
    .unwrap_err();
    assert!(!must_not);
    assert_eq!(limited.status, 429);
    assert!(
        limited.message == "rate_limited" || limited.message == "max_inflight_exceeded"
    );

    let mut pubs_b = 0u32;
    submit_agent_invoke(
        &json!({"agent":"demo","version":"1.0.0"}),
        &quiet,
        &reg_b,
        &lim,
        |_s, _t| {
            pubs_b += 1;
            Ok(())
        },
    )
    .await
    .unwrap();
    assert_eq!(pubs_b, 1, "quiet tenant must still publish");

    lim.release("tenant-noisy", &ok_a.run_id).await;
    let lim2 = limiter(Arc::clone(&kv), limits, t + 2000);
    submit_agent_invoke(
        &json!({"agent":"demo","version":"1.0.0"}),
        &noisy,
        &reg_a,
        &lim2,
        |_s, _t| Ok(()),
    )
    .await
    .unwrap();

    let (st, body) = handle_submit_http(
        &json!({"agent":"demo","version":"1"}),
        &noisy,
        &RunRegistry::new(),
        &limiter(Arc::new(MemoryKv::new()), Limits {
            rate_per_sec: 1.0,
            burst: 1.0,
            max_inflight: 1,
        }, t),
        |_s, _t| Ok(()),
    )
    .await;
    assert_eq!(st, 202);
    assert!(body.get("run_id").is_some());

    assert!(is_terminal_invoke_event("aura.events.agent.invoke.done"));
    assert!(is_terminal_invoke_event("aura.events.agent.invoke.error"));
    assert!(is_terminal_stream_frame(&json!({"type":"run.completed"})));
    assert!(is_terminal_stream_frame(&json!({"type":"error"})));
    assert!(!is_terminal_invoke_event("aura.events.agent.invoke.other"));

    let kv_r = Arc::new(MemoryKv::new());
    let lim_r = limiter(Arc::clone(&kv_r), Limits::default(), t);
    lim_r.try_acquire("t", "r1").await.unwrap();
    let (ok, released) =
        release_inflight_from_event("aura.events.agent.invoke.done", "t", "r1", &lim_r).await;
    assert!(ok && released);
    let (ok2, released2) =
        release_inflight_from_event("aura.events.agent.invoke.done", "t", "r1", &lim_r).await;
    assert!(ok2 && !released2);
}
