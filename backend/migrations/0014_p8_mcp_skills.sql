CREATE TABLE IF NOT EXISTS mcp_servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    url TEXT NOT NULL,
    auth_header TEXT NOT NULL DEFAULT '',
    allowed_tools TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    high_risk_tools TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    enabled BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_mcp_server_name UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS agent_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_agent_skill_name UNIQUE (account_id, name)
);

ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_servers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mcp_servers_tenant ON mcp_servers;
CREATE POLICY mcp_servers_tenant ON mcp_servers
    USING (account_id = (SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid))
    WITH CHECK (account_id = (SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid));

ALTER TABLE agent_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_skills_tenant ON agent_skills;
CREATE POLICY agent_skills_tenant ON agent_skills
    USING (account_id = (SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid))
    WITH CHECK (account_id = (SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_servers TO aura_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_skills TO aura_app;
