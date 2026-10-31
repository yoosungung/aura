package routing_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/routing"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestRoute_RoundRobinOnlineAgents(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	kv, err := routing.EnsureKV(ctx, js)
	if err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	a := seedOnlineAgent(t, admin, accountID, inboxID, "a@acme.test")
	b := seedOnlineAgent(t, admin, accountID, inboxID, "b@acme.test")
	coreSvc := &core.Service{DB: app}
	svc := &routing.Service{DB: app, Capacity: routing.Store{KV: kv}, Assigner: coreSvc}

	first, err := coreSvc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := coreSvc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w2"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Route(ctx, accountID, inboxID, first.ConversationID, "t"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Route(ctx, accountID, inboxID, second.ConversationID, "t"); err != nil {
		t.Fatal(err)
	}
	var firstA, secondA uuid.UUID
	if err := admin.QueryRow(ctx, `SELECT assignee_id FROM conversations WHERE id = $1`, first.ConversationID).Scan(&firstA); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT assignee_id FROM conversations WHERE id = $1`, second.ConversationID).Scan(&secondA); err != nil {
		t.Fatal(err)
	}
	if firstA != a && firstA != b {
		t.Fatalf("first %s", firstA)
	}
	if secondA != a && secondA != b {
		t.Fatalf("second %s", secondA)
	}
	if firstA == secondA {
		t.Fatalf("same agent %s", firstA)
	}
}

func TestRoute_CapacityBlocksSecondTicket(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	kv, err := routing.EnsureKV(ctx, js)
	if err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	if _, err := admin.Exec(ctx, `UPDATE inboxes SET auto_assignment_capacity = 1 WHERE id = $1`, inboxID); err != nil {
		t.Fatal(err)
	}
	agent := seedOnlineAgent(t, admin, accountID, inboxID, "ada@acme.test")
	coreSvc := &core.Service{DB: app}
	svc := &routing.Service{DB: app, Capacity: routing.Store{KV: kv}, Assigner: coreSvc}
	first, err := coreSvc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := coreSvc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w2"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Route(ctx, accountID, inboxID, first.ConversationID, "t"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Route(ctx, accountID, inboxID, second.ConversationID, "t"); err != nil {
		t.Fatal(err)
	}
	var firstA *uuid.UUID
	var secondA *uuid.UUID
	if err := admin.QueryRow(ctx, `SELECT assignee_id FROM conversations WHERE id = $1`, first.ConversationID).Scan(&firstA); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT assignee_id FROM conversations WHERE id = $1`, second.ConversationID).Scan(&secondA); err != nil {
		t.Fatal(err)
	}
	if firstA == nil || *firstA != agent {
		t.Fatalf("first %+v", firstA)
	}
	if secondA != nil {
		t.Fatalf("second assigned %s", *secondA)
	}
}

func TestRoute_OfflineUntilPresence(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	kv, err := routing.EnsureKV(ctx, js)
	if err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	agent := seedAgentStatus(t, admin, accountID, inboxID, "ada@acme.test", "offline")
	coreSvc := &core.Service{DB: app}
	svc := &routing.Service{DB: app, Capacity: routing.Store{KV: kv}, Assigner: coreSvc}
	created, err := coreSvc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Route(ctx, accountID, inboxID, created.ConversationID, "t"); err != nil {
		t.Fatal(err)
	}
	var assignee *uuid.UUID
	if err := admin.QueryRow(ctx, `SELECT assignee_id FROM conversations WHERE id = $1`, created.ConversationID).Scan(&assignee); err != nil {
		t.Fatal(err)
	}
	if assignee != nil {
		t.Fatalf("assigned while offline %s", *assignee)
	}
	if err := coreSvc.SetPresence(ctx, core.PresenceInput{
		UserID: agent, AccountID: accountID, Status: "online",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.Route(ctx, accountID, inboxID, created.ConversationID, "t"); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT assignee_id FROM conversations WHERE id = $1`, created.ConversationID).Scan(&assignee); err != nil {
		t.Fatal(err)
	}
	if assignee == nil || *assignee != agent {
		t.Fatalf("assignee %+v", assignee)
	}
}

func TestRoute_OffHoursGreetsAndSkipsAssign(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	kv, err := routing.EnsureKV(ctx, js)
	if err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	if _, err := admin.Exec(ctx, `
		UPDATE inboxes SET greeting_message = '부재중', business_hours_enabled = true, business_hours = $2::jsonb
		WHERE id = $1`, inboxID, weekdayHours()); err != nil {
		t.Fatal(err)
	}
	_ = seedOnlineAgent(t, admin, accountID, inboxID, "ada@acme.test")
	loc, err := time.LoadLocation("Asia/Seoul")
	if err != nil {
		t.Fatal(err)
	}
	sat := time.Date(2026, 1, 3, 10, 0, 0, 0, loc)
	coreSvc := &core.Service{DB: app}
	svc := &routing.Service{
		DB: app, Capacity: routing.Store{KV: kv}, Assigner: coreSvc, Greeter: coreSvc,
		Now: func() time.Time { return sat },
	}
	created, err := coreSvc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Route(ctx, accountID, inboxID, created.ConversationID, "t"); err != nil {
		t.Fatal(err)
	}
	var assignee *uuid.UUID
	if err := admin.QueryRow(ctx, `SELECT assignee_id FROM conversations WHERE id = $1`, created.ConversationID).Scan(&assignee); err != nil {
		t.Fatal(err)
	}
	if assignee != nil {
		t.Fatalf("assigned off hours %s", *assignee)
	}
	var n int
	var content string
	if err := admin.QueryRow(ctx, `
		SELECT count(*), COALESCE(max(content), '') FROM messages
		WHERE conversation_id = $1 AND sender_type = 'AgentBot'`, created.ConversationID,
	).Scan(&n, &content); err != nil {
		t.Fatal(err)
	}
	if n != 1 || content != "부재중" {
		t.Fatalf("n=%d content=%s", n, content)
	}
}

func TestConsume_AssignsOnMessageCreated(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	kv, err := routing.EnsureKV(ctx, js)
	if err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	agent := seedOnlineAgent(t, admin, accountID, inboxID, "ada@acme.test")
	coreSvc := &core.Service{DB: app}
	svc := &routing.Service{DB: app, Capacity: routing.Store{KV: kv}, Assigner: coreSvc}
	go func() { _ = svc.Consume(ctx, js) }()
	time.Sleep(200 * time.Millisecond)

	created, err := coreSvc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	msgID, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	env, err := json.Marshal(map[string]any{
		"id": msgID.String(), "schema_version": 1, "type": "message_created",
		"occurred_at": time.Now().UTC().Format(time.RFC3339Nano),
		"account_id":  accountID.String(), "inbox_id": inboxID.String(),
		"conversation_id": created.ConversationID.String(), "trace_id": "t", "hop_count": 0,
		"payload": map[string]any{
			"content": "hi", "message_type": 0, "private": false, "status": "sent", "content_type": "text",
			"sender_type": "Contact", "sender_id": created.ContactID.String(),
			"contact_id": created.ContactID.String(), "contact_inbox_id": created.ContactInboxID.String(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.Publish(ctx, "helpdesk.events."+accountID.String()+"."+inboxID.String()+"."+created.ConversationID.String()+".message_created", env); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var assignee *uuid.UUID
		if err := admin.QueryRow(ctx, `SELECT assignee_id FROM conversations WHERE id = $1`, created.ConversationID).Scan(&assignee); err != nil {
			t.Fatal(err)
		}
		if assignee != nil && *assignee == agent {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("not assigned")
}

func seedInbox(t *testing.T, admin *pgx.Conn) (accountID, inboxID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	accountID, inboxID = mustV7(t), mustV7(t)
	if _, err := admin.Exec(ctx, `INSERT INTO accounts (id, name) VALUES ($1, 'acme')`, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `INSERT INTO inboxes (id, account_id, name, channel_type, hmac_secret)
		VALUES ($1,$2,'web','web','secret')`, inboxID, accountID); err != nil {
		t.Fatal(err)
	}
	return accountID, inboxID
}

func seedOnlineAgent(t *testing.T, admin *pgx.Conn, accountID, inboxID uuid.UUID, email string) uuid.UUID {
	t.Helper()
	return seedAgentStatus(t, admin, accountID, inboxID, email, "online")
}

func seedAgentStatus(t *testing.T, admin *pgx.Conn, accountID, inboxID uuid.UUID, email, status string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	userID := mustV7(t)
	digest, err := core.HashPassword("s3cret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO users (id, email, name, password_digest, pubsub_token, availability_status)
		VALUES ($1,$2,$3,$4,$5,$6)`, userID, email, email, digest, uuid.NewString(), status); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO account_users (account_id, user_id, role) VALUES ($1,$2,'agent')`, accountID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO inbox_members (account_id, inbox_id, user_id) VALUES ($1,$2,$3)`,
		accountID, inboxID, userID); err != nil {
		t.Fatal(err)
	}
	return userID
}
