package migrate_test

import (
	"context"
	"strings"
	"testing"

	"github.com/yoosungung/aura/internal/migrate"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestUp_MessagesRLSAndIdempotent(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)

	var forced bool
	if err := admin.QueryRow(ctx, `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'messages'`).Scan(&forced); err != nil {
		t.Fatal(err)
	}
	if !forced {
		t.Fatal("expected FORCE RLS on messages")
	}

	var n int
	if err := app.QueryRow(ctx, `SELECT count(*) FROM messages`).Scan(&n); err != nil {
		t.Fatalf("app select: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected 0 visible rows without guc, got %d", n)
	}

	if err := migrate.Up(ctx, admin); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
}

func TestUp_AuthSchema(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)

	var col string
	if err := admin.QueryRow(ctx, `
		SELECT column_name FROM information_schema.columns
		WHERE table_name = 'users' AND column_name = 'password_digest'`).Scan(&col); err != nil {
		t.Fatalf("password_digest: %v", err)
	}
	var n int
	if err := app.QueryRow(ctx, `SELECT count(*) FROM sessions`).Scan(&n); err != nil {
		t.Fatalf("sessions: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected empty sessions, got %d", n)
	}
	var proname string
	if err := admin.QueryRow(ctx, `SELECT proname FROM pg_proc WHERE proname = 'auth_login_membership'`).Scan(&proname); err != nil {
		t.Fatalf("auth_login_membership: %v", err)
	}
}

func TestUp_AuthContactSeed(t *testing.T) {
	ctx := context.Background()
	admin, _ := testutil.Postgres(t)
	var proname string
	if err := admin.QueryRow(ctx, `SELECT proname FROM pg_proc WHERE proname = 'auth_contact_seed'`).Scan(&proname); err != nil {
		t.Fatalf("auth_contact_seed: %v", err)
	}
}

func TestUp_KakaoSenderKey(t *testing.T) {
	ctx := context.Background()
	admin, _ := testutil.Postgres(t)
	var col string
	if err := admin.QueryRow(ctx, `
		SELECT column_name FROM information_schema.columns
		WHERE table_name = 'inboxes' AND column_name = 'kakao_sender_key'`).Scan(&col); err != nil {
		t.Fatalf("kakao_sender_key: %v", err)
	}
	var proname string
	if err := admin.QueryRow(ctx, `SELECT proname FROM pg_proc WHERE proname = 'inbox_by_kakao'`).Scan(&proname); err != nil {
		t.Fatalf("inbox_by_kakao: %v", err)
	}
}

func TestUp_PublicArticlesSearch(t *testing.T) {
	ctx := context.Background()
	admin, _ := testutil.Postgres(t)
	var proname string
	if err := admin.QueryRow(ctx, `SELECT proname FROM pg_proc WHERE proname = 'public_articles_search'`).Scan(&proname); err != nil {
		t.Fatalf("public_articles_search: %v", err)
	}
}

func TestUp_EmbeddingsSeparatedAndTemporalEdges(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)

	var n int
	if err := admin.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'articles' AND column_name = 'embedding'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("articles.embedding should be dropped")
	}
	if err := admin.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'ontology_nodes' AND column_name = 'embedding'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("ontology_nodes.embedding should be dropped")
	}
	var col string
	if err := admin.QueryRow(ctx, `
		SELECT column_name FROM information_schema.columns
		WHERE table_name = 'ontology_edges' AND column_name = 'valid_until'`).Scan(&col); err != nil {
		t.Fatalf("valid_until: %v", err)
	}
	if err := admin.QueryRow(ctx, `
		SELECT indexname FROM pg_indexes WHERE indexname = 'idx_embeddings_hnsw'`).Scan(&col); err != nil {
		t.Fatalf("hnsw: %v", err)
	}
	var typ, def string
	if err := admin.QueryRow(ctx, `
		SELECT format_type(atttypid, atttypmod) FROM pg_attribute
		WHERE attrelid = 'embeddings'::regclass AND attname = 'embedding' AND NOT attisdropped`).Scan(&typ); err != nil {
		t.Fatalf("embedding type: %v", err)
	}
	if typ != "halfvec(1536)" {
		t.Fatalf("embedding type=%s", typ)
	}
	if err := admin.QueryRow(ctx, `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_embeddings_hnsw'`).Scan(&def); err != nil {
		t.Fatalf("hnsw def: %v", err)
	}
	if !strings.Contains(def, "halfvec_cosine_ops") || !strings.Contains(def, "m='16'") {
		t.Fatalf("hnsw def=%s", def)
	}
	if err := admin.QueryRow(ctx, `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_embeddings_hnsw_article'`).Scan(&def); err != nil {
		t.Fatalf("article hnsw: %v", err)
	}
	if !strings.Contains(def, "owner_type") {
		t.Fatalf("article hnsw def=%s", def)
	}
	var forced bool
	if err := admin.QueryRow(ctx, `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'embeddings'`).Scan(&forced); err != nil {
		t.Fatal(err)
	}
	if !forced {
		t.Fatal("expected FORCE RLS on embeddings")
	}
	if err := app.QueryRow(ctx, `SELECT count(*) FROM embeddings`).Scan(&n); err != nil {
		t.Fatalf("app embeddings: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected 0 visible embeddings without guc, got %d", n)
	}
}

func TestUp_MCPAndAgentSkills(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	var forced bool
	if err := admin.QueryRow(ctx, `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'mcp_servers'`).Scan(&forced); err != nil {
		t.Fatal(err)
	}
	if !forced {
		t.Fatal("expected FORCE RLS on mcp_servers")
	}
	if err := admin.QueryRow(ctx, `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'agent_skills'`).Scan(&forced); err != nil {
		t.Fatal(err)
	}
	if !forced {
		t.Fatal("expected FORCE RLS on agent_skills")
	}
	var n int
	if err := app.QueryRow(ctx, `SELECT count(*) FROM mcp_servers`).Scan(&n); err != nil {
		t.Fatalf("app mcp_servers: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected 0 visible mcp_servers without guc, got %d", n)
	}
}

func TestUp_AppCannotBypassRLS(t *testing.T) {
	ctx := context.Background()
	_, app := testutil.Postgres(t)
	_, err := app.Exec(ctx, `INSERT INTO messages (
		id, account_id, inbox_id, conversation_id, message_type, content, private, status, content_type, sender_type, sender_id
	) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 0, 'x', false, 'sent', 'text', 'Contact', gen_random_uuid())`)
	if err == nil {
		t.Fatal("expected RLS to block insert without guc")
	}
}
