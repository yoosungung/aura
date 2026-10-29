ALTER TABLE users
    ADD COLUMN password_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE users ALTER COLUMN password_digest DROP DEFAULT;

CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_digest VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO aura_app;

CREATE FUNCTION auth_login_membership(p_user_id UUID)
RETURNS TABLE(account_id UUID, role VARCHAR, inbox_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT au.account_id, au.role, im.inbox_id
    FROM account_users au
    LEFT JOIN inbox_members im
      ON im.user_id = au.user_id AND im.account_id = au.account_id
    WHERE au.user_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION auth_login_membership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login_membership(UUID) TO aura_app;
