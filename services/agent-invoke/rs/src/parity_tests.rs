//! agent_invoke orchestrator parity — createAgent/workers stay Node/Python (Phase 5).

use crate::*;
use aura_envelope::Envelope;
use serde_json::json;
use std::path::Path;

#[test]
fn workers_remain_nodejs_python() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    assert!(root.join("nodejs").is_dir() || root.join("DESIGN.md").is_file());
    let design = std::fs::read_to_string(root.join("DESIGN.md")).unwrap_or_default();
    assert!(
        design.contains("createAgent") || design.contains("nodejs"),
        "workers/createAgent stay outside Rust orch"
    );
}

#[test]
fn subjects_and_checkpoint_guc() {
    assert_eq!(TASK_SUBJECT, "aura.tasks.agent.invoke");
    assert_eq!(DONE_SUBJECT, "aura.events.agent.invoke.done");
    assert_eq!(ERROR_SUBJECT, "aura.events.agent.invoke.error");
    assert!(checkpoint_guc_sql().contains(", true)"));
    assert!(!checkpoint_guc_sql().contains(", false)"));
}

#[test]
fn orch_steps_and_guards() {
    let env = Envelope::new(
        "agent.invoke",
        "t",
        json!({"run_id":"rid","prompt":"hi","agent":"demo","version":"1"}),
    );
    let steps = validate_invoke(&env).unwrap();
    assert_eq!(
        steps,
        vec![
            OrchStep::Resolve,
            OrchStep::Recall,
            OrchStep::InvokeWorker,
            OrchStep::Stream,
            OrchStep::Checkpoint,
            OrchStep::Done,
        ]
    );

    let id_only = Envelope::new(
        "agent.invoke",
        "t",
        json!({"run_id":"rid","agent":"a","version":"1","bundle":{}}),
    );
    // identifiers_only: no prompt/messages
    assert_eq!(
        validate_invoke(&id_only).unwrap_err(),
        OrchError::IdentifiersOnly
    );

    let no_run = Envelope::new("agent.invoke", "t", json!({"prompt":"hi"}));
    assert_eq!(
        validate_invoke(&no_run).unwrap_err(),
        OrchError::RunIdRequired
    );

    let plan = orch_plan(&env).unwrap();
    assert_eq!(plan.worker_runtime, "nodejs");
    assert!(!plan.calls_create_agent_in_rust);
}
