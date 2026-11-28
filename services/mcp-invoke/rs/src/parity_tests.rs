//! mcp_invoke orchestrator dual async/rpc parity — PG forbidden (Phase 5).

use crate::*;
use aura_envelope::Envelope;
use serde_json::json;
use std::path::Path;

#[test]
fn no_pg_and_workers_remain() {
    let manifest = include_str!("../Cargo.toml");
    assert!(!manifest.contains("sqlx"));
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    assert!(root.join("nodejs").is_dir() || root.join("DESIGN.md").is_file());
}

#[test]
fn dual_subjects_and_allowlist() {
    assert_eq!(ASYNC_TASK, "aura.tasks.mcp.invoke");
    assert_eq!(RPC_SUBJECT, "aura.rpc.mcp.invoke");
    assert_eq!(DONE_SUBJECT, "aura.events.mcp.invoke.done");
    assert_eq!(ERROR_SUBJECT, "aura.events.mcp.invoke.error");

    let env = Envelope::new("mcp.invoke", "t", json!({"tool":"echo","args":{}}));
    assert!(validate_mcp_invoke(&env, &["echo", "search"]).is_ok());
    assert_eq!(
        validate_mcp_invoke(&env, &["search"]).unwrap_err(),
        McpOrchError::ToolNotAllowed
    );
    let missing = Envelope::new("mcp.invoke", "t", json!({}));
    assert_eq!(
        validate_mcp_invoke(&missing, &["echo"]).unwrap_err(),
        McpOrchError::ToolRequired
    );
}

#[test]
fn dual_mode_plan() {
    let async_plan = mcp_orch_plan("async", "echo", &["echo"]).unwrap();
    assert_eq!(async_plan.subject, ASYNC_TASK);
    assert!(!async_plan.uses_pg);

    let rpc_plan = mcp_orch_plan("rpc", "echo", &["echo"]).unwrap();
    assert_eq!(rpc_plan.subject, RPC_SUBJECT);
    assert!(!rpc_plan.uses_pg);

    assert_eq!(
        mcp_orch_plan("async", "deny", &["echo"]).unwrap_err(),
        McpOrchError::ToolNotAllowed
    );
}
