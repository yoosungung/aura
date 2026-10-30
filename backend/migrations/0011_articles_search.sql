CREATE FUNCTION public_articles_search(p_inbox_id UUID, p_query TEXT)
RETURNS TABLE(
    id UUID,
    title VARCHAR,
    slug VARCHAR,
    body TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT a.id, a.title, a.slug, a.body
    FROM articles a
    JOIN inboxes i ON i.account_id = a.account_id
    WHERE i.id = p_inbox_id
      AND a.published
      AND (
          COALESCE(btrim(p_query), '') = ''
          OR a.title ILIKE '%' || p_query || '%'
          OR a.body ILIKE '%' || p_query || '%'
      )
    ORDER BY a.title
    LIMIT 20;
$$;

REVOKE ALL ON FUNCTION public_articles_search(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_articles_search(UUID, TEXT) TO aura_app;
