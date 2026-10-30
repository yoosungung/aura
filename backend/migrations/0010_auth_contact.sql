CREATE FUNCTION auth_contact_seed(p_inbox_id UUID, p_pubsub_token TEXT)
RETURNS TABLE(
    account_id UUID,
    inbox_id UUID,
    contact_id UUID,
    contact_inbox_id UUID,
    source_id TEXT,
    conversation_id UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT ci.account_id, ci.inbox_id, ci.contact_id, ci.id, ci.source_id,
        (SELECT c.id FROM conversations c
         WHERE c.contact_inbox_id = ci.id AND c.status <> 'resolved'
         ORDER BY c.updated_at DESC LIMIT 1)
    FROM contact_inboxes ci
    WHERE ci.inbox_id = p_inbox_id AND ci.pubsub_token = p_pubsub_token;
$$;

REVOKE ALL ON FUNCTION auth_contact_seed(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_contact_seed(UUID, TEXT) TO aura_app;
