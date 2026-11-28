//! Tenant Fair Queue — Token Bucket + max_inflight (ARCHITECTURE §2.2).

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub const DEFAULT_RATE_PER_SEC: f64 = 10.0;
pub const DEFAULT_BURST: f64 = 30.0;
pub const DEFAULT_MAX_INFLIGHT: u32 = 20;
const MAX_CAS_ATTEMPTS: usize = 32;

#[derive(Debug, Clone)]
pub struct Limits {
    pub rate_per_sec: f64,
    pub burst: f64,
    pub max_inflight: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            rate_per_sec: DEFAULT_RATE_PER_SEC,
            burst: DEFAULT_BURST,
            max_inflight: DEFAULT_MAX_INFLIGHT,
        }
    }
}

#[derive(Debug, Clone)]
pub struct QuotaState {
    pub tokens: f64,
    pub updated_at_ms: u64,
    pub inflight: u32,
    pub runs: HashMap<String, bool>,
}

#[derive(Debug, Clone)]
struct KvEntry {
    value: QuotaState,
    revision: u64,
}

#[derive(Default)]
pub struct MemoryKv {
    inner: Mutex<HashMap<String, KvEntry>>,
}

impl MemoryKv {
    pub fn new() -> Self {
        Self::default()
    }

    async fn get(&self, key: &str) -> Option<KvEntry> {
        self.inner.lock().await.get(key).cloned()
    }

    async fn cas(&self, key: &str, expected_revision: u64, value: QuotaState) -> bool {
        let mut map = self.inner.lock().await;
        let cur_rev = map.get(key).map(|e| e.revision).unwrap_or(0);
        if cur_rev != expected_revision {
            return false;
        }
        map.insert(
            key.to_string(),
            KvEntry {
                value,
                revision: expected_revision + 1,
            },
        );
        true
    }
}

pub fn quota_key(tenant_id: &str) -> Result<String, String> {
    if tenant_id.trim().is_empty() {
        return Err("tenant_id_required".into());
    }
    Ok(format!("quota.{tenant_id}"))
}

fn empty_state(burst: f64, now_ms: u64) -> QuotaState {
    QuotaState {
        tokens: burst,
        updated_at_ms: now_ms,
        inflight: 0,
        runs: HashMap::new(),
    }
}

fn refill(state: &QuotaState, now_ms: u64, limits: &Limits) -> QuotaState {
    let elapsed = now_ms.saturating_sub(state.updated_at_ms) as f64;
    let added = (limits.rate_per_sec * elapsed) / 1000.0;
    QuotaState {
        tokens: (state.tokens + added).min(limits.burst),
        updated_at_ms: now_ms,
        inflight: state.inflight,
        runs: state.runs.clone(),
    }
}

fn retry_after_ms(state: &QuotaState, limits: &Limits) -> u64 {
    if state.inflight >= limits.max_inflight {
        return 1000;
    }
    if state.tokens >= 1.0 {
        return 1;
    }
    let need = 1.0 - state.tokens;
    ((need / limits.rate_per_sec) * 1000.0).ceil().max(1.0) as u64
}

#[derive(Debug, Clone)]
pub struct AcquireErr {
    pub error: String,
    pub status: u16,
    pub retry_after_ms: u64,
}

pub struct TenantRateLimiter {
    kv: Arc<MemoryKv>,
    limits: Limits,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl TenantRateLimiter {
    pub fn new(
        kv: Arc<MemoryKv>,
        limits: Limits,
        now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self { kv, limits, now_ms }
    }

    pub async fn try_acquire(
        &self,
        tenant_id: &str,
        run_id: &str,
    ) -> Result<(), AcquireErr> {
        if run_id.is_empty() {
            return Err(AcquireErr {
                error: "run_id_required".into(),
                status: 400,
                retry_after_ms: 1,
            });
        }
        let key = quota_key(tenant_id).map_err(|e| AcquireErr {
            error: e,
            status: 400,
            retry_after_ms: 1,
        })?;
        let now = (self.now_ms)();

        for _ in 0..MAX_CAS_ATTEMPTS {
            let raw = self.kv.get(&key).await;
            let revision = raw.as_ref().map(|e| e.revision).unwrap_or(0);
            let mut state = match raw {
                Some(e) => refill(&e.value, now, &self.limits),
                None => empty_state(self.limits.burst, now),
            };

            if state.runs.contains_key(run_id) {
                return Ok(());
            }
            if state.tokens < 1.0 {
                return Err(AcquireErr {
                    error: "rate_limited".into(),
                    status: 429,
                    retry_after_ms: retry_after_ms(&state, &self.limits),
                });
            }
            if state.inflight >= self.limits.max_inflight {
                return Err(AcquireErr {
                    error: "max_inflight_exceeded".into(),
                    status: 429,
                    retry_after_ms: retry_after_ms(&state, &self.limits),
                });
            }

            state.tokens -= 1.0;
            state.inflight += 1;
            state.runs.insert(run_id.to_string(), true);
            state.updated_at_ms = now;

            if self.kv.cas(&key, revision, state).await {
                return Ok(());
            }
        }
        Err(AcquireErr {
            error: "quota_cas_contention".into(),
            status: 503,
            retry_after_ms: 50,
        })
    }

    /// Returns (ok, released).
    pub async fn release(&self, tenant_id: &str, run_id: &str) -> (bool, bool) {
        if run_id.is_empty() {
            return (true, false);
        }
        let Ok(key) = quota_key(tenant_id) else {
            return (true, false);
        };
        let now = (self.now_ms)();
        for _ in 0..MAX_CAS_ATTEMPTS {
            let Some(raw) = self.kv.get(&key).await else {
                return (true, false);
            };
            let revision = raw.revision;
            let mut state = refill(&raw.value, now, &self.limits);
            if !state.runs.contains_key(run_id) {
                return (true, false);
            }
            state.runs.remove(run_id);
            state.inflight = state.inflight.saturating_sub(1);
            state.updated_at_ms = now;
            if self.kv.cas(&key, revision, state).await {
                return (true, true);
            }
        }
        (false, false)
    }
}

pub fn is_terminal_stream_frame(frame: &serde_json::Value) -> bool {
    matches!(
        frame.get("type").and_then(|v| v.as_str()),
        Some("run.completed") | Some("error")
    )
}

pub fn is_terminal_invoke_event(subject: &str) -> bool {
    subject == "aura.events.agent.invoke.done" || subject == "aura.events.agent.invoke.error"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acquire_and_release_idempotent() {
        let kv = Arc::new(MemoryKv::new());
        let now = Arc::new(|| 1_700_000_000_000u64);
        let lim = TenantRateLimiter::new(kv, Limits::default(), now);
        lim.try_acquire("t1", "r1").await.unwrap();
        lim.try_acquire("t1", "r1").await.unwrap();
        let (ok, released) = lim.release("t1", "r1").await;
        assert!(ok && released);
        let (ok2, released2) = lim.release("t1", "r1").await;
        assert!(ok2 && !released2);
    }

    #[tokio::test]
    async fn max_inflight_429() {
        let kv = Arc::new(MemoryKv::new());
        let now = Arc::new(|| 1_700_000_000_000u64);
        let lim = TenantRateLimiter::new(
            kv,
            Limits {
                rate_per_sec: 100.0,
                burst: 100.0,
                max_inflight: 2,
            },
            now,
        );
        lim.try_acquire("t", "a").await.unwrap();
        lim.try_acquire("t", "b").await.unwrap();
        let err = lim.try_acquire("t", "c").await.unwrap_err();
        assert_eq!(err.status, 429);
        assert_eq!(err.error, "max_inflight_exceeded");
    }
}
