package core_test

import (
	"context"
	"testing"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestTransition_ResolvedInsertsCSAT(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Transition(ctx, core.TransitionInput{
		AccountID: accountID, ConversationID: created.ConversationID,
		NewStatus: core.StatusResolved, ExpectedVersion: 1, TraceID: "t",
	}); err != nil {
		t.Fatal(err)
	}
	var contentType, content string
	var n int
	if err := admin.QueryRow(ctx, `
		SELECT content_type, COALESCE(content, ''), count(*) OVER ()
		FROM messages WHERE conversation_id = $1 AND content_type = 'input_csat'`,
		created.ConversationID).Scan(&contentType, &content, &n); err != nil {
		t.Fatal(err)
	}
	if contentType != "input_csat" || content != core.CSATContent || n != 1 {
		t.Fatalf("type=%s content=%s n=%d", contentType, content, n)
	}
	var resolvedAt any
	if err := admin.QueryRow(ctx, `SELECT resolved_at FROM conversations WHERE id = $1`, created.ConversationID).Scan(&resolvedAt); err != nil {
		t.Fatal(err)
	}
	if resolvedAt == nil {
		t.Fatal("resolved_at empty")
	}
}

func TestTransition_PendingSkipsCSAT(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Transition(ctx, core.TransitionInput{
		AccountID: accountID, ConversationID: created.ConversationID,
		NewStatus: core.StatusPending, ExpectedVersion: 1, TraceID: "t",
	}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM messages WHERE conversation_id = $1`, created.ConversationID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("messages=%d", n)
	}
}
