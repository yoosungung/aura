-- control meta: tenant_meta + source_meta + user_meta + control_audit + RLS
-- Contract: ARCHITECTURE §1 #6 · §6.1 · deploy/docs/svc-control-resolve.md · deploy/docs/admin-ui.md
-- Non-goals: ACL/membership · OIDC. Admin HTTP + resolve Pooler = M6+.
-- Idempotent for smoke/dev (DROP CASCADE). Production migrate path is later.

BEGIN;

DROP TABLE IF EXISTS control_audit CASCADE;
DROP TABLE IF EXISTS user_meta CASCADE;
DROP TABLE IF EXISTS source_meta CASCADE;
DROP TABLE IF EXISTS tenant_meta CASCADE;

-- Ops tenant catalog (alias). id = tenant UUID used everywhere else.
-- Platform ops table: RLS policies allow ALL (grants only to control-admin role).
CREATE TABLE tenant_meta (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_tenant_meta_display_name CHECK (char_length(btrim(display_name)) >= 1)
);

CREATE INDEX idx_tenant_meta_display_name ON tenant_meta (display_name);

ALTER TABLE tenant_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_meta FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_meta_ops_all ON tenant_meta;
CREATE POLICY tenant_meta_ops_all ON tenant_meta
  FOR ALL
  USING (true)
  WITH CHECK (true);

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

-- Append-only admin audit (app UPDATE/DELETE forbidden).
CREATE TABLE control_audit (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_id    TEXT NOT NULL,
  reason         TEXT,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_control_audit_tenant_at
  ON control_audit (tenant_id, at DESC);

ALTER TABLE control_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS control_audit_tenant_isolation ON control_audit;
CREATE POLICY control_audit_tenant_isolation ON control_audit
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

COMMIT;
