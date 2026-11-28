//! mcp_invoke orchestrator shell (Phase 5). Workers stay Node/Python. PG forbidden.

use aura_envelope::{Envelope, EnvelopeError};

#[cfg(test)]
mod parity_tests;

pub const ASYNC_TASK: &str = "aura.tasks.mcp.invoke";
pub const RPC_SUBJECT: &str = "aura.rpc.mcp.invoke";
pub const DONE_SUBJECT: &str = "aura.events.mcp.invoke.done";
pub const ERROR_SUBJECT: &str = "aura.events.mcp.invoke.error";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum McpOrchError {
    #[error("envelope: {0}")]
    Envelope(#[from] EnvelopeError),
    #[error("tool_not_allowed")]
    ToolNotAllowed,
    #[error("tool_required")]
    ToolRequired,
    #[error("mode_invalid")]
    ModeInvalid,
}

pub fn is_tool_allowed(tool: &str, allowlist: &[&str]) -> bool {
    allowlist.contains(&tool)
}

pub fn validate_mcp_invoke(env: &Envelope, allowlist: &[&str]) -> Result<(), McpOrchError> {
    env.validate()?;
    let tool = env
        .payload
        .get("tool")
        .and_then(|v| v.as_str())
        .ok_or(McpOrchError::ToolRequired)?;
    if !is_tool_allowed(tool, allowlist) {
        return Err(McpOrchError::ToolNotAllowed);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpOrchPlan {
    pub subject: &'static str,
    pub tool: String,
    pub uses_pg: bool,
}

pub fn mcp_orch_plan(
    mode: &str,
    tool: &str,
    allowlist: &[&str],
) -> Result<McpOrchPlan, McpOrchError> {
    if !is_tool_allowed(tool, allowlist) {
        return Err(McpOrchError::ToolNotAllowed);
    }
    let subject = match mode {
        "async" => ASYNC_TASK,
        "rpc" => RPC_SUBJECT,
        _ => return Err(McpOrchError::ModeInvalid),
    };
    Ok(McpOrchPlan {
        subject,
        tool: tool.to_string(),
        uses_pg: false,
    })
}
