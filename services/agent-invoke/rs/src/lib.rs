//! agent_invoke orchestrator shell (Phase 5). createAgent/workers stay Node/Python.

use aura_envelope::{Envelope, EnvelopeError};
use aura_tenant_tx::SET_TENANT_GUC_SQL;
use serde_json::Value;

#[cfg(test)]
mod parity_tests;

pub const TASK_SUBJECT: &str = "aura.tasks.agent.invoke";
pub const DONE_SUBJECT: &str = "aura.events.agent.invoke.done";
pub const ERROR_SUBJECT: &str = "aura.events.agent.invoke.error";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrchStep {
    Resolve,
    Recall,
    InvokeWorker,
    Stream,
    Checkpoint,
    Done,
    Error,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OrchError {
    #[error("envelope: {0}")]
    Envelope(#[from] EnvelopeError),
    #[error("identifiers_only")]
    IdentifiersOnly,
    #[error("run_id_required")]
    RunIdRequired,
    #[error("tenant_id_required")]
    TenantIdRequired,
}

/// Reject payloads that only carry identifiers without content (wire guard).
pub fn reject_identifiers_only(payload: &Value) -> Result<(), OrchError> {
    for forbidden in ["bundle", "bundle_uri", "cfg", "config", "secrets"] {
        if payload.get(forbidden).is_some() {
            return Err(OrchError::IdentifiersOnly);
        }
    }
    let has_prompt = payload
        .get("prompt")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let has_messages = payload
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if !has_prompt && !has_messages {
        return Err(OrchError::IdentifiersOnly);
    }
    Ok(())
}

pub fn validate_invoke(env: &Envelope) -> Result<Vec<OrchStep>, OrchError> {
    env.validate()?;
    if env.tenant_id.trim().is_empty() {
        return Err(OrchError::TenantIdRequired);
    }
    let run_id = env
        .payload
        .get("run_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if run_id.is_empty() {
        return Err(OrchError::RunIdRequired);
    }
    reject_identifiers_only(&env.payload)?;
    Ok(vec![
        OrchStep::Resolve,
        OrchStep::Recall,
        OrchStep::InvokeWorker,
        OrchStep::Stream,
        OrchStep::Checkpoint,
        OrchStep::Done,
    ])
}

pub fn checkpoint_guc_sql() -> &'static str {
    SET_TENANT_GUC_SQL
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrchPlan {
    pub steps: Vec<OrchStep>,
    pub worker_runtime: String,
    /// Rust orch never embeds createAgent — workers own factory.
    pub calls_create_agent_in_rust: bool,
}

pub fn orch_plan(env: &Envelope) -> Result<OrchPlan, OrchError> {
    let steps = validate_invoke(env)?;
    let runtime = env
        .payload
        .get("runtime")
        .and_then(|v| v.as_str())
        .unwrap_or("nodejs")
        .to_string();
    Ok(OrchPlan {
        steps,
        worker_runtime: runtime,
        calls_create_agent_in_rust: false,
    })
}
