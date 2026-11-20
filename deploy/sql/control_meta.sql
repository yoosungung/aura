-- control meta: source_meta + user_meta + RLS
-- Contract: ARCHITECTURE §1 #6 · §6.1 · deploy/docs/svc-control-resolve.md
-- Ticket: 51bc0936. Non-goals: tenants/ACL tables · NATS resolve bridge · HTTP admin server.
-- Idempotent for M3 smoke/dev (DROP CASCADE). Production migrate path is later.

BEGIN;

DROP TABLE IF EXISTS user_meta CASCADE;
DROP TABLE IF EXISTS source_meta CASCADE;

-- Immutable versioned bundle/code definition (per tenant).
CREATE TABLE source_meta (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  kind         TEXT NOT NULL,
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  entrypoint   TEXT NOT NULL,
  bundle_uri   TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  sig_uri      TEXT,
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  runtime      TEXT NOT NULL DEFAULT 'nodejs',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_source_meta_kind CHECK (kind IN ('agent', 'mcp')),
  CONSTRAINT chk_source_meta_runtime CHECK (runtime IN ('nodejs', 'python', 'custom')),
  CONSTRAINT chk_source_meta_status CHECK (status IN ('pending', 'active', 'retired')),
  CONSTRAINT uq_source_meta_tenant_kind_name_version UNIQUE (tenant_id, kind, name, version)
);

CREATE INDEX idx_source_meta_lookup
  ON source_meta (tenant_id, kind, name, version);
CREATE INDEX idx_source_meta_status
  ON source_meta (tenant_id, status);

ALTER TABLE source_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_meta FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS source_meta_tenant_isolation ON source_meta;
CREATE POLICY source_meta_tenant_isolation ON source_meta
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

-- Mutable per-principal config overlay (secrets_ref only — never plaintext).
CREATE TABLE user_meta (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  source_meta_id  UUID NOT NULL REFERENCES source_meta (id) ON DELETE CASCADE,
  principal_id    TEXT NOT NULL,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  secrets_ref     TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_meta_source_principal UNIQUE (source_meta_id, principal_id)
);

CREATE INDEX idx_user_meta_principal
  ON user_meta (tenant_id, principal_id);

ALTER TABLE user_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_meta FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_meta_tenant_isolation ON user_meta;
CREATE POLICY user_meta_tenant_isolation ON user_meta
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

COMMIT;
