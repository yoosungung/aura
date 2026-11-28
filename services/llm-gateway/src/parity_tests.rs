//! Node `gateway.selftest.js` parity — cluster-free (Phase 2B TDD).

use crate::*;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

fn tiers() -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert("simple".into(), "model-cheap".into());
    m.insert("medium".into(), "model-mid".into());
    m.insert("complex".into(), "model-strong".into());
    m
}

#[test]
fn clients_remain_node_python() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    assert!(root.join("client.js").is_file(), "client.js must stay");
    assert!(root.join("client.py").is_file(), "client.py must stay");
    let js = std::fs::read_to_string(root.join("client.js")).unwrap();
    assert!(js.contains("provider_direct_forbidden") || js.contains("assertFunctionLlmEgress"));
}

#[test]
fn router_heuristic_units() {
    let simple = score_prompt(&[json!({"role":"user","content":"hi"})]);
    assert_eq!(simple.tier, "simple");

    let complex = score_prompt(&[json!({
        "role":"user",
        "content":"Please analyze step-by-step and refactor this function carefully: ```js\nfunction x(){}\n```"
    })]);
    assert_eq!(complex.tier, "complex");

    let r = resolve_route(
        AUTO_MODEL,
        &[json!({"role":"user","content":"hi"})],
        None,
        Some(&tiers()),
    );
    assert!(r.routed);
    assert_eq!(r.model, "model-cheap");
    assert_eq!(r.route.as_ref().unwrap().tier, "simple");

    let pinned = resolve_route(
        AUTO_MODEL,
        &[json!({"role":"user","content":"hi"})],
        Some("complex"),
        Some(&tiers()),
    );
    assert_eq!(pinned.model, "model-strong");
    assert_eq!(pinned.route.as_ref().unwrap().tier, "complex");

    let empty = HashMap::new();
    let err = resolve_route(
        AUTO_MODEL,
        &[json!({"role":"user","content":"hi"})],
        None,
        Some(&empty),
    );
    assert_eq!(err.error.as_deref(), Some("routing_tiers_empty"));
}

#[test]
fn validation_and_defaults() {
    let billing = BillingStore::default();
    let providers: Vec<Box<dyn ChatProvider>> = vec![Box::new(StubProvider::ok("stub", "ok"))];
    let missing = chat_completions(
        "",
        &json!({"model":"m","messages":[{"role":"user","content":"x"}]}),
        None,
        &tiers(),
        &providers,
        &billing,
        None,
        None,
    );
    assert_eq!(missing.status, 400);
    assert_eq!(missing.body["error"], "tenant_id_required");

    let bad = chat_completions(
        "t1",
        &json!({"model":"m","messages":"nope"}),
        None,
        &tiers(),
        &providers,
        &billing,
        None,
        None,
    );
    assert_eq!(bad.status, 400);
    assert_eq!(bad.body["error"], "messages_required");

    assert!(DEFAULT_RATE_PER_SEC > 0.0);
    assert!(DEFAULT_BURST >= 1.0);
}

#[test]
fn chat_happy_path_and_billing() {
    let billing = BillingStore::default();
    let providers: Vec<Box<dyn ChatProvider>> =
        vec![Box::new(StubProvider::ok("stub", "hello-from-stub"))];
    let out = chat_completions(
        "t1",
        &json!({
            "model":"aura-default",
            "messages":[{"role":"user","content":"ping"}]
        }),
        None,
        &tiers(),
        &providers,
        &billing,
        None,
        None,
    );
    assert_eq!(out.status, 200);
    assert_eq!(out.body["object"], "chat.completion");
    assert!(out.body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap()
        .contains("hello-from-stub"));
    let u = billing.usage("t1");
    assert!(u["prompt_tokens"].as_u64().unwrap() >= 1);
    assert!(u["cost_usd"].as_f64().unwrap() > 0.0);
    assert_eq!(u["entries"].as_array().unwrap().len(), 1);
}

#[test]
fn fallback_on_primary_failure() {
    let billing = BillingStore::default();
    let primary_calls = Arc::new(AtomicU32::new(0));
    let fallback_calls = Arc::new(AtomicU32::new(0));
    let p_calls = Arc::clone(&primary_calls);
    let f_calls = Arc::clone(&fallback_calls);

    let providers: Vec<Box<dyn ChatProvider>> = vec![
        Box::new(FnProvider {
            id: "primary".into(),
            f: Box::new(move |_m, _msgs| {
                p_calls.fetch_add(1, Ordering::SeqCst);
                ProviderOutcome::Err {
                    code: "provider_error".into(),
                    message: "primary_down".into(),
                }
            }),
        }),
        Box::new(FnProvider {
            id: "fallback".into(),
            f: Box::new(move |model, _msgs| {
                f_calls.fetch_add(1, Ordering::SeqCst);
                ProviderOutcome::Ok(ProviderResponse {
                    id: "chatcmpl-fb".into(),
                    model: if model.is_empty() {
                        "aura-fallback".into()
                    } else {
                        model.to_string()
                    },
                    content: "from-fallback".into(),
                    prompt_tokens: 2,
                    completion_tokens: 3,
                    provider: "fallback".into(),
                })
            }),
        }),
    ];

    let res = chat_completions(
        "t-fb",
        &json!({
            "model":"aura-default",
            "messages":[{"role":"user","content":"hi"}]
        }),
        None,
        &tiers(),
        &providers,
        &billing,
        None,
        None,
    );
    assert_eq!(res.status, 200);
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(fallback_calls.load(Ordering::SeqCst), 1);
    assert!(res.body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap()
        .contains("from-fallback"));
    assert_eq!(res.body["aura"]["fallback_used"], true);
    assert_eq!(res.body["aura"]["provider"], "fallback");
    assert!(res.body["aura"]["attempts"].as_array().unwrap().len() >= 2);
    let entry = &billing.usage("t-fb")["entries"][0];
    assert_eq!(entry["fallback_used"], true);
    assert_eq!(entry["provider"], "fallback");
}

#[test]
fn aura_auto_routes_and_records_tier() {
    let billing = BillingStore::default();
    let providers: Vec<Box<dyn ChatProvider>> =
        vec![Box::new(StubProvider::ok("p", "routed"))];
    let hi = chat_completions(
        "t-auto",
        &json!({
            "model":"aura-auto",
            "messages":[{"role":"user","content":"hi"}]
        }),
        None,
        &tiers(),
        &providers,
        &billing,
        None,
        None,
    );
    assert_eq!(hi.status, 200);
    assert_eq!(hi.body["model"], "model-cheap");
    assert_eq!(hi.body["aura"]["model_requested"], "aura-auto");
    assert_eq!(hi.body["aura"]["route"]["tier"], "simple");
    assert_eq!(billing.usage("t-auto")["entries"][0]["route_tier"], "simple");
}

#[test]
fn tenant_rate_limit_429() {
    let billing = BillingStore::default();
    let providers: Vec<Box<dyn ChatProvider>> =
        vec![Box::new(StubProvider::ok("p", "x"))];
    let rl = LlmRateLimiter::new(1.0, 1.0, Arc::new(|| 1_000_000u64));

    let a = chat_completions(
        "noisy",
        &json!({"model":"m","messages":[{"role":"user","content":"a"}]}),
        None,
        &tiers(),
        &providers,
        &billing,
        Some(&rl),
        None,
    );
    assert_eq!(a.status, 200);

    let b = chat_completions(
        "noisy",
        &json!({"model":"m","messages":[{"role":"user","content":"b"}]}),
        None,
        &tiers(),
        &providers,
        &billing,
        Some(&rl),
        None,
    );
    assert_eq!(b.status, 429);
    assert_eq!(b.body["error"], "rate_limited");

    let other = chat_completions(
        "quiet",
        &json!({"model":"m","messages":[{"role":"user","content":"c"}]}),
        None,
        &tiers(),
        &providers,
        &billing,
        Some(&rl),
        None,
    );
    assert_eq!(other.status, 200);
}

#[test]
fn all_providers_fail_returns_502() {
    let billing = BillingStore::default();
    let providers: Vec<Box<dyn ChatProvider>> = vec![
        Box::new(StubProvider::fail("a")),
        Box::new(StubProvider::fail("b")),
    ];
    let out = chat_completions(
        "t",
        &json!({"model":"m","messages":[{"role":"user","content":"x"}]}),
        None,
        &tiers(),
        &providers,
        &billing,
        None,
        None,
    );
    assert_eq!(out.status, 502);
    assert_eq!(out.body["error"], "all_providers_failed");
    assert!(out.body["aura"]["attempts"].as_array().unwrap().len() >= 2);
}

#[test]
fn circuit_breaker_opens_after_failures() {
    let billing = BillingStore::default();
    let fail_count = Arc::new(AtomicU32::new(0));
    let fc = Arc::clone(&fail_count);
    let providers: Vec<Box<dyn ChatProvider>> = vec![Box::new(FnProvider {
        id: "flaky".into(),
        f: Box::new(move |_m, _msgs| {
            fc.fetch_add(1, Ordering::SeqCst);
            ProviderOutcome::Err {
                code: "provider_error".into(),
                message: "upstream_down".into(),
            }
        }),
    })];
    let cb = CircuitBreaker::new(2, 60_000, Arc::new(|| 1_000_000u64));

    let r1 = chat_completions(
        "cb",
        &json!({"model":"m","messages":[{"role":"user","content":"1"}]}),
        None,
        &tiers(),
        &providers,
        &billing,
        None,
        Some(&cb),
    );
    assert_eq!(r1.status, 502);

    let r2 = chat_completions(
        "cb",
        &json!({"model":"m","messages":[{"role":"user","content":"2"}]}),
        None,
        &tiers(),
        &providers,
        &billing,
        None,
        Some(&cb),
    );
    assert_eq!(r2.status, 502);

    let r3 = chat_completions(
        "cb",
        &json!({"model":"m","messages":[{"role":"user","content":"3"}]}),
        None,
        &tiers(),
        &providers,
        &billing,
        None,
        Some(&cb),
    );
    assert_eq!(r3.status, 503);
    assert_eq!(r3.body["error"], "circuit_open");
    assert_eq!(
        fail_count.load(Ordering::SeqCst),
        2,
        "open circuit must not call provider"
    );
}

#[test]
fn fallback_skips_open_circuit() {
    let billing = BillingStore::default();
    let primary_calls = Arc::new(AtomicU32::new(0));
    let fallback_calls = Arc::new(AtomicU32::new(0));
    let p_calls = Arc::clone(&primary_calls);
    let f_calls = Arc::clone(&fallback_calls);

    let providers: Vec<Box<dyn ChatProvider>> = vec![
        Box::new(FnProvider {
            id: "prim-open".into(),
            f: Box::new(move |_m, _msgs| {
                p_calls.fetch_add(1, Ordering::SeqCst);
                ProviderOutcome::Err {
                    code: "provider_error".into(),
                    message: "should_not".into(),
                }
            }),
        }),
        Box::new(FnProvider {
            id: "fb-ok".into(),
            f: Box::new(move |model, _msgs| {
                f_calls.fetch_add(1, Ordering::SeqCst);
                ProviderOutcome::Ok(ProviderResponse {
                    id: "ok".into(),
                    model: if model.is_empty() {
                        "aura-fallback".into()
                    } else {
                        model.to_string()
                    },
                    content: "circuit-skip".into(),
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    provider: "fb-ok".into(),
                })
            }),
        }),
    ];

    let cb = CircuitBreaker::new(1, 60_000, Arc::new(|| 1_000_000u64));
    cb.record_failure("prim-open");

    let res = chat_completions(
        "t-cb-fb",
        &json!({
            "model":"aura-default",
            "messages":[{"role":"user","content":"x"}]
        }),
        None,
        &tiers(),
        &providers,
        &billing,
        None,
        Some(&cb),
    );
    assert_eq!(res.status, 200);
    assert_eq!(
        primary_calls.load(Ordering::SeqCst),
        0,
        "open circuit must skip primary"
    );
    assert_eq!(fallback_calls.load(Ordering::SeqCst), 1);
    assert_eq!(res.body["aura"]["fallback_used"], true);
}
