//! LLM Gateway core — aura-auto router + ordered Fallback + billing stub (Phase 2B).
//! `client.js` / `client.py` remain the Function egress clients (non-goals for Rust).

mod router;

pub use router::*;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[cfg(test)]
mod parity_tests;

pub const DEFAULT_RATE_PER_SEC: f64 = 20.0;
pub const DEFAULT_BURST: f64 = 40.0;

#[derive(Debug, Clone)]
pub struct ProviderResponse {
    pub id: String,
    pub model: String,
    pub content: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub provider: String,
}

#[derive(Debug, Clone)]
pub enum ProviderOutcome {
    Ok(ProviderResponse),
    Err { code: String, message: String },
}

pub trait ChatProvider: Send + Sync {
    fn id(&self) -> &str;
    fn complete(&self, model: &str, messages: &[Value]) -> ProviderOutcome;
}

pub struct StubProvider {
    pub id: String,
    pub fail: bool,
    pub content: String,
}

impl StubProvider {
    pub fn ok(id: &str, content: &str) -> Self {
        Self {
            id: id.into(),
            fail: false,
            content: content.into(),
        }
    }

    pub fn fail(id: &str) -> Self {
        Self {
            id: id.into(),
            fail: true,
            content: String::new(),
        }
    }
}

impl ChatProvider for StubProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn complete(&self, model: &str, _messages: &[Value]) -> ProviderOutcome {
        if self.fail {
            return ProviderOutcome::Err {
                code: "provider_error".into(),
                message: "upstream_down".into(),
            };
        }
        ProviderOutcome::Ok(ProviderResponse {
            id: format!("stub-{}", self.id),
            model: model.to_string(),
            content: self.content.clone(),
            prompt_tokens: 10,
            completion_tokens: 20,
            provider: self.id.clone(),
        })
    }
}

pub struct FnProvider {
    pub id: String,
    #[allow(clippy::type_complexity)]
    pub f: Box<dyn Fn(&str, &[Value]) -> ProviderOutcome + Send + Sync>,
}

impl ChatProvider for FnProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn complete(&self, model: &str, messages: &[Value]) -> ProviderOutcome {
        (self.f)(model, messages)
    }
}

#[derive(Debug, Clone)]
pub struct UsageEntry {
    pub tenant_id: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost_usd: f64,
    pub provider: String,
    pub fallback_used: bool,
    pub route_tier: Option<String>,
}

#[derive(Default)]
pub struct BillingStore {
    entries: Mutex<Vec<UsageEntry>>,
}

impl BillingStore {
    pub fn record(&self, entry: UsageEntry) {
        self.entries.lock().unwrap().push(entry);
    }

    pub fn usage(&self, tenant: &str) -> Value {
        let entries = self.entries.lock().unwrap();
        let mine: Vec<&UsageEntry> = entries.iter().filter(|e| e.tenant_id == tenant).collect();
        let prompt: u64 = mine.iter().map(|e| e.prompt_tokens).sum();
        let completion: u64 = mine.iter().map(|e| e.completion_tokens).sum();
        let cost: f64 = mine.iter().map(|e| e.cost_usd).sum();
        json!({
            "tenant_id": tenant,
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "cost_usd": cost,
            "entries": mine.iter().map(|e| json!({
                "tenant_id": e.tenant_id,
                "prompt_tokens": e.prompt_tokens,
                "completion_tokens": e.completion_tokens,
                "cost_usd": e.cost_usd,
                "provider": e.provider,
                "fallback_used": e.fallback_used,
                "route_tier": e.route_tier,
            })).collect::<Vec<_>>(),
        })
    }
}

struct TokenBucket {
    tokens: f64,
    updated_at_ms: u64,
}

pub struct LlmRateLimiter {
    rate_per_sec: f64,
    burst: f64,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Mutex<HashMap<String, TokenBucket>>,
}

impl LlmRateLimiter {
    pub fn new(
        rate_per_sec: f64,
        burst: f64,
        now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            rate_per_sec,
            burst,
            now_ms,
            state: Mutex::new(HashMap::new()),
        }
    }

    pub fn try_acquire(&self, tenant_id: &str) -> bool {
        let now = (self.now_ms)();
        let mut map = self.state.lock().unwrap();
        let bucket = map.entry(tenant_id.to_string()).or_insert(TokenBucket {
            tokens: self.burst,
            updated_at_ms: now,
        });
        let elapsed = now.saturating_sub(bucket.updated_at_ms) as f64;
        bucket.tokens = (bucket.tokens + (self.rate_per_sec * elapsed) / 1000.0).min(self.burst);
        bucket.updated_at_ms = now;
        if bucket.tokens < 1.0 {
            return false;
        }
        bucket.tokens -= 1.0;
        true
    }
}

#[derive(Debug, Clone)]
struct CircuitState {
    failures: u32,
    open_until_ms: u64,
}

/// Per-provider circuit breaker (JS `createCircuitBreaker` parity).
pub struct CircuitBreaker {
    failure_threshold: u32,
    cooldown_ms: u64,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Mutex<HashMap<String, CircuitState>>,
}

impl CircuitBreaker {
    pub fn new(
        failure_threshold: u32,
        cooldown_ms: u64,
        now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            failure_threshold: failure_threshold.max(1),
            cooldown_ms,
            now_ms,
            state: Mutex::new(HashMap::new()),
        }
    }

    pub fn allow(&self, name: &str) -> bool {
        let now = (self.now_ms)();
        let map = self.state.lock().unwrap();
        match map.get(name) {
            Some(s) if s.open_until_ms > 0 && now < s.open_until_ms => false,
            _ => true,
        }
    }

    pub fn record_success(&self, name: &str) {
        let mut map = self.state.lock().unwrap();
        map.insert(
            name.to_string(),
            CircuitState {
                failures: 0,
                open_until_ms: 0,
            },
        );
    }

    pub fn record_failure(&self, name: &str) {
        let now = (self.now_ms)();
        let mut map = self.state.lock().unwrap();
        let prev = map.get(name).cloned().unwrap_or(CircuitState {
            failures: 0,
            open_until_ms: 0,
        });
        let failures = prev.failures.saturating_add(1);
        let open_until_ms = if failures >= self.failure_threshold {
            now.saturating_add(self.cooldown_ms)
        } else {
            0
        };
        map.insert(
            name.to_string(),
            CircuitState {
                failures,
                open_until_ms,
            },
        );
    }
}

#[derive(Debug)]
pub struct ChatResult {
    pub status: u16,
    pub body: Value,
}

fn estimate_cost(prompt: u64, completion: u64) -> f64 {
    (prompt as f64 * 0.00001) + (completion as f64 * 0.00003)
}

/// Ordered Fallback over providers; first success wins. Live HTTP providers = canary.
pub fn chat_completions(
    tenant_id: &str,
    body: &Value,
    pin: Option<&str>,
    tiers: &HashMap<String, String>,
    providers: &[Box<dyn ChatProvider>],
    billing: &BillingStore,
    rate_limiter: Option<&LlmRateLimiter>,
    circuit: Option<&CircuitBreaker>,
) -> ChatResult {
    if tenant_id.is_empty() {
        return ChatResult {
            status: 400,
            body: json!({"error":"tenant_id_required"}),
        };
    }
    let messages = match body.get("messages") {
        Some(Value::Array(a)) => a.clone(),
        _ => {
            return ChatResult {
                status: 400,
                body: json!({"error":"messages_required"}),
            };
        }
    };
    if let Some(rl) = rate_limiter {
        if !rl.try_acquire(tenant_id) {
            return ChatResult {
                status: 429,
                body: json!({"error":"rate_limited"}),
            };
        }
    }

    let requested = body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("aura-default");
    let route = resolve_route(requested, &messages, pin, Some(tiers));
    if let Some(err) = &route.error {
        return ChatResult {
            status: 503,
            body: json!({"error": err}),
        };
    }

    if providers.is_empty() {
        return ChatResult {
            status: 503,
            body: json!({"error":"no_providers"}),
        };
    }

    let model = if route.routed {
        route.model.clone()
    } else {
        requested.to_string()
    };

    let mut attempts = Vec::new();
    let mut last_err: Option<(String, String)> = None;

    for (i, p) in providers.iter().enumerate() {
        let pid = p.id().to_string();
        if let Some(cb) = circuit {
            if !cb.allow(&pid) {
                attempts.push(json!({
                    "provider": pid,
                    "ok": false,
                    "error": "circuit_open",
                }));
                last_err = Some(("circuit_open".into(), "circuit_open".into()));
                continue;
            }
        }
        match p.complete(&model, &messages) {
            ProviderOutcome::Ok(resp) => {
                if let Some(cb) = circuit {
                    cb.record_success(&pid);
                }
                let fallback_used = i > 0;
                attempts.push(json!({
                    "provider": p.id(),
                    "model": resp.model,
                    "ok": true,
                }));
                let cost = estimate_cost(resp.prompt_tokens, resp.completion_tokens);
                billing.record(UsageEntry {
                    tenant_id: tenant_id.into(),
                    prompt_tokens: resp.prompt_tokens,
                    completion_tokens: resp.completion_tokens,
                    cost_usd: cost,
                    provider: resp.provider.clone(),
                    fallback_used,
                    route_tier: route.route.as_ref().map(|r| r.tier.clone()),
                });
                let mut out = json!({
                    "id": resp.id,
                    "object": "chat.completion",
                    "model": if route.routed { model.clone() } else { resp.model.clone() },
                    "choices": [{
                        "index": 0,
                        "message": {"role":"assistant","content": resp.content},
                        "finish_reason": "stop"
                    }],
                    "usage": {
                        "prompt_tokens": resp.prompt_tokens,
                        "completion_tokens": resp.completion_tokens,
                        "total_tokens": resp.prompt_tokens + resp.completion_tokens
                    },
                    "aura": {
                        "fallback_used": fallback_used,
                        "provider": resp.provider,
                        "model_served": resp.model,
                        "model_requested": requested,
                        "attempts": attempts,
                    }
                });
                if let Some(r) = &route.route {
                    out["aura"]["route"] = json!({
                        "tier": r.tier,
                        "reason": r.reason,
                        "model_selected": r.model_selected,
                        "pin": r.pin,
                    });
                }
                return ChatResult {
                    status: 200,
                    body: out,
                };
            }
            ProviderOutcome::Err { code, message } => {
                if let Some(cb) = circuit {
                    cb.record_failure(&pid);
                }
                attempts.push(json!({
                    "provider": p.id(),
                    "ok": false,
                    "error": code,
                    "message": message,
                }));
                last_err = Some((code, message));
            }
        }
    }

    let _ = last_err;
    if attempts.len() == 1
        && attempts[0].get("error").and_then(|v| v.as_str()) == Some("circuit_open")
    {
        return ChatResult {
            status: 503,
            body: json!({"error":"circuit_open","aura":{"attempts": attempts}}),
        };
    }
    ChatResult {
        status: 502,
        body: json!({
            "error": "all_providers_failed",
            "aura": { "attempts": attempts, "fallback_used": attempts.len() > 1 }
        }),
    }
}

/// Convenience for single-stub Deployment smoke (main.rs).
pub fn chat_completions_stub(
    tenant_id: &str,
    body: &Value,
    pin: Option<&str>,
    tiers: &HashMap<String, String>,
    providers: &[crate::Provider],
    billing: &BillingStore,
) -> ChatResult {
    let boxed: Vec<Box<dyn ChatProvider>> = providers
        .iter()
        .map(|p| {
            Box::new(StubProvider {
                id: p.id.clone(),
                fail: false,
                content: "stub".into(),
            }) as Box<dyn ChatProvider>
        })
        .collect();
    chat_completions(tenant_id, body, pin, tiers, &boxed, billing, None, None)
}

/// Legacy metadata used by main/Dockerfile smoke path.
#[derive(Debug, Clone)]
pub struct Provider {
    pub id: String,
    pub model: String,
    pub kind: String,
}
