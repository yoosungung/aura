ALTER TABLE inboxes ADD COLUMN kakao_sender_key VARCHAR(255);

CREATE UNIQUE INDEX uq_inbox_kakao_sender_key
    ON inboxes (kakao_sender_key)
    WHERE kakao_sender_key IS NOT NULL AND kakao_sender_key <> '';

CREATE FUNCTION inbox_by_kakao(p_sender_key TEXT)
RETURNS TABLE(account_id UUID, inbox_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT i.account_id, i.id
    FROM inboxes i
    WHERE i.kakao_sender_key IS NOT NULL
      AND i.kakao_sender_key <> ''
      AND i.kakao_sender_key = btrim(p_sender_key)
    LIMIT 1;
$$;

REVOKE ALL ON FUNCTION inbox_by_kakao(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inbox_by_kakao(TEXT) TO aura_app;
