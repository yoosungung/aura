//! Transaction-local tenant GUC (ARCHITECTURE §1 #4 · §2.1).
//!
//! Only `SELECT set_config('app.tenant_id', $1, true)` is allowed.
//! Session `SET` / `set_config(..., false)` are forbidden.

use thiserror::Error;

/// Canonical SQL — third argument MUST stay `true` (is_local).
pub const SET_TENANT_GUC_SQL: &str = "SELECT set_config('app.tenant_id', $1, true)";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TenantTxError {
    #[error("tenant_id_required")]
    TenantIdRequired,
    #[error("session_guc_forbidden")]
    SessionGucForbidden,
}

/// Reject empty tenant ids (Node `withTenantTx` parity).
pub fn require_tenant_id(tenant_id: &str) -> Result<(), TenantTxError> {
    if tenant_id.trim().is_empty() {
        return Err(TenantTxError::TenantIdRequired);
    }
    Ok(())
}

/// Defense-in-depth: never allow is_local=false at the call site.
pub fn assert_is_local(is_local: bool) -> Result<(), TenantTxError> {
    if !is_local {
        return Err(TenantTxError::SessionGucForbidden);
    }
    Ok(())
}

/// Returns the bind SQL only after validating tenant + is_local=true.
pub fn set_tenant_guc_sql(tenant_id: &str) -> Result<&'static str, TenantTxError> {
    require_tenant_id(tenant_id)?;
    assert_is_local(true)?;
    // Static string is hard-coded to `true` — grep-friendly for check scripts.
    debug_assert!(SET_TENANT_GUC_SQL.contains(", true)"));
    debug_assert!(!SET_TENANT_GUC_SQL.contains(", false)"));
    Ok(SET_TENANT_GUC_SQL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_is_transaction_local_true() {
        assert!(SET_TENANT_GUC_SQL.contains("set_config('app.tenant_id'"));
        assert!(SET_TENANT_GUC_SQL.ends_with(", true)"));
        assert!(!SET_TENANT_GUC_SQL.contains(", false)"));
    }

    #[test]
    fn rejects_empty_tenant() {
        assert_eq!(
            require_tenant_id(""),
            Err(TenantTxError::TenantIdRequired)
        );
        assert_eq!(
            set_tenant_guc_sql("  "),
            Err(TenantTxError::TenantIdRequired)
        );
    }

    #[test]
    fn rejects_session_guc() {
        assert_eq!(
            assert_is_local(false),
            Err(TenantTxError::SessionGucForbidden)
        );
    }

    #[test]
    fn accepts_valid_tenant() {
        assert_eq!(set_tenant_guc_sql("tenant-a").unwrap(), SET_TENANT_GUC_SQL);
    }
}
