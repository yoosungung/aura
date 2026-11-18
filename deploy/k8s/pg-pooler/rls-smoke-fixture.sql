-- Minimal RLS fixture for Pooler + set_config(..., true) smoke (ticket 92cccf21).
-- Not production memory DDL — full schema lands with services/memory (M1).
-- Contract: ARCHITECTURE §1 #4 · §2.1 · §6 RLS line.
-- Explicit transaction: PgBouncer transaction pooling assigns a server per txn;
-- autocommit DDL can race orphan pg_type across pool backends.

BEGIN;

DROP TABLE IF EXISTS smoke_tenant_rows CASCADE;

CREATE TABLE smoke_tenant_rows (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  label      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE smoke_tenant_rows ENABLE ROW LEVEL SECURITY;
-- Owner (aura) must not bypass — otherwise pool reuse smoke is meaningless.
ALTER TABLE smoke_tenant_rows FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS smoke_tenant_isolation ON smoke_tenant_rows;
CREATE POLICY smoke_tenant_isolation ON smoke_tenant_rows
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

COMMIT;
