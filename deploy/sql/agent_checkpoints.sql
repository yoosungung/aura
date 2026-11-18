-- Runtime exception table: agent_checkpoints (§1 #10 · §6.1)
-- Write owner: agent_invoke only (Pooler + set_config('app.tenant_id', $1, true)).
-- Ticket: 24e94cd4. Non-goals: live writer · resume API · TTL/partition GC.
-- Idempotent for M3 smoke/dev (DROP CASCADE). Production migrate path is later.

BEGIN;

DROP TABLE IF EXISTS agent_checkpoints CASCADE;

-- Append-only resumable snapshots for a single agent run (Zero Direct Write exception).
CREATE TABLE agent_checkpoints (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  run_id                TEXT NOT NULL,          -- Gateway UUIDv7 string (§7)
  session_id            TEXT NOT NULL,          -- conversation scope
  principal_id          TEXT NOT NULL,
  seq                   BIGINT NOT NULL,        -- monotonic within (tenant_id, run_id)
  parent_id             UUID,                   -- prior checkpoint in same run (soft lineage)
  kind                  TEXT NOT NULL,          -- 'turn' | 'tool' | 'final'
  state_schema_version  INTEGER NOT NULL DEFAULT 1,
  state                 JSONB NOT NULL DEFAULT '{}'::jsonb,  -- small resumable snapshot
  content_ref           TEXT,                   -- large / PII → Object Store (§8); never plaintext secrets
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_agent_checkpoints_kind CHECK (kind IN ('turn', 'tool', 'final')),
  CONSTRAINT chk_agent_checkpoints_seq_nonneg CHECK (seq >= 0),
  CONSTRAINT uq_agent_checkpoints_tenant_run_seq UNIQUE (tenant_id, run_id, seq)
);

CREATE INDEX idx_agent_checkpoints_run
  ON agent_checkpoints (tenant_id, run_id, seq DESC);
CREATE INDEX idx_agent_checkpoints_session
  ON agent_checkpoints (tenant_id, session_id, created_at DESC);

ALTER TABLE agent_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_checkpoints FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_checkpoints_tenant_isolation ON agent_checkpoints;
CREATE POLICY agent_checkpoints_tenant_isolation ON agent_checkpoints
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

COMMIT;
