CREATE TABLE event_outbox (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMPTZ
);

ALTER TABLE event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_outbox_tenant ON event_outbox
  USING (account_id = (SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid))
  WITH CHECK (account_id = (SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON event_outbox TO aura_app;
