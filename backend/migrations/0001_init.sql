CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    locale VARCHAR(10) DEFAULT 'ko' NOT NULL,
    domain VARCHAR(255),
    custom_attributes JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE account_sequences (
    account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    last_conversation_display_id BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    availability_status VARCHAR(50) DEFAULT 'offline' NOT NULL,
    pubsub_token VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE account_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_account_user UNIQUE (account_id, user_id)
);

CREATE TABLE inboxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    channel_type VARCHAR(50) NOT NULL,
    enable_auto_assignment BOOLEAN DEFAULT TRUE NOT NULL,
    greeting_message TEXT,
    business_hours_enabled BOOLEAN DEFAULT FALSE NOT NULL,
    business_hours JSONB DEFAULT '{}'::jsonb NOT NULL,
    hmac_secret VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE inbox_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    inbox_id UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_inbox_user UNIQUE (inbox_id, user_id)
);

CREATE TABLE contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255),
    email VARCHAR(255),
    phone_number VARCHAR(50),
    identifier VARCHAR(255),
    custom_attributes JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_contact_email_account UNIQUE (account_id, email),
    CONSTRAINT uq_contact_identifier_account UNIQUE (account_id, identifier)
);

CREATE TABLE contact_inboxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    inbox_id UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
    source_id VARCHAR(255) NOT NULL,
    pubsub_token VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_inbox_source UNIQUE (inbox_id, source_id)
);

CREATE TABLE conversations (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    inbox_id UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    contact_inbox_id UUID NOT NULL REFERENCES contact_inboxes(id) ON DELETE CASCADE,
    assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(50) DEFAULT 'unassigned' NOT NULL,
    priority VARCHAR(50) DEFAULT 'medium' NOT NULL,
    first_reply_created_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    snoozed_until TIMESTAMPTZ,
    display_id BIGINT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    custom_attributes JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_conversation_display UNIQUE (account_id, display_id)
);

CREATE TABLE messages (
    id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    inbox_id UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_type INT NOT NULL,
    content TEXT,
    private BOOLEAN DEFAULT FALSE NOT NULL,
    status VARCHAR(50) DEFAULT 'sent' NOT NULL,
    source_id VARCHAR(255),
    content_type VARCHAR(50) DEFAULT 'text' NOT NULL,
    sender_type VARCHAR(50) NOT NULL,
    sender_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_message_source UNIQUE (inbox_id, source_id)
);

CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_type VARCHAR(50) NOT NULL,
    external_url TEXT NOT NULL,
    file_size INT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE labels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    color VARCHAR(32),
    CONSTRAINT uq_label_name UNIQUE (account_id, name)
);

CREATE TABLE conversation_labels (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, label_id)
);

CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    CONSTRAINT uq_team_name UNIQUE (account_id, name)
);

CREATE TABLE team_members (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE canned_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    short_code VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    CONSTRAINT uq_canned UNIQUE (account_id, short_code)
);

CREATE TABLE macros (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    actions JSONB NOT NULL,
    visibility VARCHAR(50) DEFAULT 'account' NOT NULL,
    created_by UUID REFERENCES users(id)
);

CREATE TABLE automation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    event_name VARCHAR(100) NOT NULL,
    conditions JSONB NOT NULL,
    actions JSONB NOT NULL,
    enabled BOOLEAN DEFAULT TRUE NOT NULL
);

CREATE TABLE sla_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    frt_threshold_seconds INT,
    nrt_threshold_seconds INT,
    rt_threshold_seconds INT,
    only_business_hours BOOLEAN DEFAULT TRUE NOT NULL
);

CREATE TABLE applied_slas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sla_policy_id UUID NOT NULL REFERENCES sla_policies(id) ON DELETE CASCADE,
    frt_due_at TIMESTAMPTZ,
    nrt_due_at TIMESTAMPTZ,
    rt_due_at TIMESTAMPTZ,
    is_frt_breached BOOLEAN DEFAULT FALSE NOT NULL,
    is_nrt_breached BOOLEAN DEFAULT FALSE NOT NULL,
    is_rt_breached BOOLEAN DEFAULT FALSE NOT NULL
);

CREATE TABLE csat_survey_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    assigned_agent_id UUID REFERENCES users(id),
    rating INT NOT NULL,
    feedback TEXT,
    review_note TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    subscriptions TEXT[] NOT NULL,
    secret VARCHAR(255) NOT NULL
);

CREATE TABLE articles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    published BOOLEAN DEFAULT FALSE NOT NULL,
    embedding vector(1536),
    CONSTRAINT uq_article_slug UNIQUE (account_id, slug)
);

CREATE TABLE ontology_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    entity_type VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    external_ref_id VARCHAR(255),
    properties JSONB DEFAULT '{}'::jsonb NOT NULL,
    embedding vector(1536),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE ontology_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    source_node_id UUID NOT NULL REFERENCES ontology_nodes(id) ON DELETE CASCADE,
    target_node_id UUID NOT NULL REFERENCES ontology_nodes(id) ON DELETE CASCADE,
    relation_type VARCHAR(100) NOT NULL,
    weight FLOAT DEFAULT 1.0 NOT NULL,
    properties JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT uq_edge UNIQUE (account_id, source_node_id, target_node_id, relation_type)
);

CREATE TABLE agent_tool_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    tool_name VARCHAR(100) NOT NULL,
    input_args JSONB NOT NULL,
    output_result JSONB NOT NULL,
    is_success BOOLEAN NOT NULL,
    requires_approval BOOLEAN DEFAULT FALSE NOT NULL,
    approved_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX idx_conversations_account_status ON conversations(account_id, status);
CREATE INDEX idx_conversations_assignee_open ON conversations(account_id, assignee_id) WHERE status = 'open';
CREATE INDEX idx_messages_conv_created ON messages(account_id, conversation_id, created_at ASC);
CREATE INDEX idx_contact_inboxes_lookup ON contact_inboxes(account_id, inbox_id, source_id);
CREATE INDEX idx_ontology_nodes_ref ON ontology_nodes(account_id, entity_type, external_ref_id);
CREATE INDEX idx_ontology_edges_traversal ON ontology_edges(account_id, source_node_id, relation_type);

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'account_sequences',
        'account_users',
        'inboxes',
        'inbox_members',
        'contacts',
        'contact_inboxes',
        'conversations',
        'messages',
        'attachments',
        'labels',
        'conversation_labels',
        'teams',
        'team_members',
        'canned_responses',
        'macros',
        'automation_rules',
        'sla_policies',
        'applied_slas',
        'csat_survey_responses',
        'webhooks',
        'articles',
        'ontology_nodes',
        'ontology_edges',
        'agent_tool_executions'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I USING (account_id = (SELECT NULLIF(current_setting(''app.current_account_id'', true), '''')::uuid)) WITH CHECK (account_id = (SELECT NULLIF(current_setting(''app.current_account_id'', true), '''')::uuid))',
            t || '_tenant',
            t
        );
    END LOOP;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aura_app') THEN
        CREATE ROLE aura_app LOGIN PASSWORD 'aura_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END $$;

DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO aura_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO aura_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aura_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aura_app;
