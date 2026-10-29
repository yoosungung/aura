package migrate_test

import (
	"context"
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
