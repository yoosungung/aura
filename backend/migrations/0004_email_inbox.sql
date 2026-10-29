ALTER TABLE inboxes ADD COLUMN email_address VARCHAR(255);

CREATE UNIQUE INDEX uq_inbox_email_address
    ON inboxes (lower(email_address))
    WHERE email_address IS NOT NULL AND email_address <> '';

CREATE FUNCTION inbox_by_email(p_email TEXT)
RETURNS TABLE(account_id UUID, inbox_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT i.account_id, i.id
    FROM inboxes i
    WHERE i.email_address IS NOT NULL
      AND i.email_address <> ''
      AND lower(i.email_address) = lower(btrim(p_email))
    LIMIT 1;
$$;

REVOKE ALL ON FUNCTION inbox_by_email(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inbox_by_email(TEXT) TO aura_app;
