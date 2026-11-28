//! Node resolve.selftest / secrets-mask / admin wire parity — Pooler stub (Phase 3).

use crate::*;
use serde_json::{json, Value};

#[test]
fn merge_configs_user_wins_one_depth() {
    let m = merge_configs(
        &json!({"timeout_seconds":30,"llm":{"model":"a","temp":0.2}}),
        &json!({"llm":{"model":"b"},"flag":true}),
    );
    assert_eq!(m["timeout_seconds"], 30);
    assert_eq!(m["llm"]["model"], "b");
    assert_eq!(m["llm"]["temp"], 0.2);
    assert_eq!(m["flag"], true);
    assert_eq!(merge_configs(&json!({"a":1}), &Value::Null), json!({"a":1}));
    assert_eq!(merge_configs(&json!({"a":1}), &json!({})), json!({"a":1}));
}

#[test]
fn validate_resolve_request_cases() {
    let tenant = "11111111-1111-1111-1111-111111111111";
    assert!(validate_resolve_request(&json!({
        "tenant_id": tenant, "kind":"agent", "name":"demo", "version":"1.0.0",
        "principal":{"id":"user-1","tenant_id": tenant}
    }))
    .is_ok());
    assert_eq!(
        validate_resolve_request(&json!({
            "tenant_id": tenant, "kind":"agent", "name":"demo", "version":"1.0.0",
            "principal":{"id":"user-1","tenant_id":"other"}
        }))
        .unwrap_err(),
        "tenant_mismatch"
    );
    assert_eq!(
        validate_resolve_request(&json!({
            "kind":"agent","name":"demo","version":"1",
            "principal":{"id":"u","tenant_id":"t"}
        }))
        .unwrap_err(),
        "tenant_id_required"
    );
    assert_eq!(
        validate_resolve_request(&json!({
            "tenant_id":"t","kind":"bot","name":"demo","version":"1",
            "principal":{"id":"u","tenant_id":"t"}
        }))
        .unwrap_err(),
        "kind_invalid"
    );
}

#[test]
fn build_resolve_response_wire_and_no_secrets() {
    let source = json!({
        "id":"22222222-2222-2222-2222-222222222222",
        "tenant_id":"11111111-1111-1111-1111-111111111111",
        "kind":"agent","name":"demo","version":"1.0.0",
        "entrypoint":"main:factory",
        "bundle_uri":"s3://aura-content/bundles/demo.zip",
        "checksum":"sha256:abc",
        "config":{"llm":{"model":"base"},"timeout_seconds":10},
        "status":"active",
        "created_at":"2026-11-19T00:00:00Z"
    });
    let user = json!({
        "id":"33333333-3333-3333-3333-333333333333",
        "tenant_id":"11111111-1111-1111-1111-111111111111",
        "source_meta_id":"22222222-2222-2222-2222-222222222222",
        "principal_id":"user-1",
        "config":{"llm":{"model":"override"}},
        "secrets_ref":"k8s:secret/aura-user-demo",
        "updated_at":"2026-11-19T01:00:00Z"
    });
    let done = build_resolve_response(&source, Some(&user));
    assert_eq!(done["type"], "control.resolve.done");
    assert_eq!(done["source"]["name"], "demo");
    assert_eq!(done["user"]["principal_id"], "user-1");
    assert_eq!(done["cfg"]["llm"]["model"], "override");
    assert_eq!(done["cfg"]["timeout_seconds"], 10);
    assert_eq!(done["secrets_ref"], "k8s:secret/aura-user-demo");
    assert_eq!(done["runtime"], "nodejs");
    assert!(done.get("secrets").is_none());
    assert!(!done.to_string().contains("sk-"));

    let retired = build_resolve_response(&json!({
        "status":"retired","config":{},"kind":"agent","name":"n","version":"1",
        "tenant_id":"t","id":"s","bundle_uri":"x","checksum":"c"
    }), None);
    assert_eq!(retired["type"], "control.resolve.error");
    assert_eq!(retired["error"], "source_not_active");

    let py = build_resolve_response(
        &json!({
            "id":"s","tenant_id":"t","kind":"agent","name":"n","version":"1",
            "bundle_uri":"u","checksum":"c","config":{},"status":"active",
            "runtime":"python"
        }),
        None,
    );
    assert_eq!(py["runtime"], "python");
    assert_eq!(py["user"], Value::Null);
    assert_eq!(py["secrets_ref"], Value::Null);

    let custom = build_resolve_response(
        &json!({
            "id":"s","tenant_id":"t","kind":"agent","name":"n","version":"1",
            "bundle_uri":"custom://f","checksum":"c","config":{},"status":"active",
            "runtime":"custom","entrypoint":null,"function":"aura-agent-invoke-demo"
        }),
        None,
    );
    assert_eq!(custom["runtime"], "custom");
    assert_eq!(custom["function"], "aura-agent-invoke-demo");
}

#[test]
fn pooler_stub_resolve_and_guc() {
    assert!(tenant_guc_sql().contains(", true)"));
    assert!(!tenant_guc_sql().contains(", false)"));

    let pooler = StubPooler::with_source(json!({
        "id":"s","tenant_id":"t","kind":"agent","name":"demo","version":"1",
        "bundle_uri":"u","checksum":"c","config":{"a":1},"status":"active"
    }));
    let req = json!({
        "tenant_id":"t","kind":"agent","name":"demo","version":"1",
        "principal":{"id":"u","tenant_id":"t"}
    });
    let out = resolve_with_pooler(&req, &pooler).unwrap();
    assert_eq!(out["type"], "control.resolve.done");
    assert_eq!(pooler.last_guc_is_local(), Some(true));

    let missing = StubPooler::empty();
    let err = resolve_with_pooler(&req, &missing).unwrap();
    assert_eq!(err["type"], "control.resolve.error");
    assert_eq!(err["error"], "source_not_found");
}

#[test]
fn admin_audit_mask_and_paths() {
    let masked = admin_audit_insert_shape("t", "ops", "activate");
    assert_eq!(masked["token"], "***");
    assert_eq!(masked["tenant_id"], "t");
    assert_eq!(masked["action"], "activate");

    let deep = mask_admin_payload(&json!({
        "password":"x",
        "nested":{"api_key":"k","ok":1}
    }));
    assert_eq!(deep["password"], "***");
    assert_eq!(deep["nested"]["api_key"], "***");
    assert_eq!(deep["nested"]["ok"], 1);

    let paths = allowed_admin_paths();
    assert!(paths.contains("/v1/audit"));
    assert!(paths.contains("/v1/tenants"));

    let (st, body) = admin_list_tenants_stub();
    assert_eq!(st, 200);
    assert!(body["tenants"].as_array().unwrap().is_empty());

    let (st2, audit) = admin_post_audit_stub("t", "ops", "activate", Some("reason"));
    assert_eq!(st2, 201);
    assert_eq!(audit["ok"], true);
    assert_eq!(audit["row"]["token"], "***");
}
