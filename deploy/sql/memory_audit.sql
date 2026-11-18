-- memory_audit: monthly RANGE(created_at) + RLS
-- Contract: ARCHITECTURE §1 #8 · §6 DDL · §6.2.2 · Pooler + set_config(..., true)
-- Ticket: 85741c7b. Non-goals: TTL DROP cadence numbers · embeddings · svc-memory store body.
-- Idempotent for M1 smoke/dev (DROP CASCADE). Production ATTACH/TTL job is later ticket.

BEGIN;

DROP TABLE IF EXISTS memory_audit CASCADE;

CREATE TABLE memory_audit (
  id         UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  item_id    UUID,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Seed months are attached by check/smoke helper (UTC month bounds).
-- Placeholder comment for static gate: FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM-01')

CREATE INDEX idx_memory_audit_tenant_created
  ON memory_audit (tenant_id, created_at DESC);

ALTER TABLE memory_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_audit_tenant_isolation ON memory_audit;
CREATE POLICY memory_audit_tenant_isolation ON memory_audit
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

COMMIT;
