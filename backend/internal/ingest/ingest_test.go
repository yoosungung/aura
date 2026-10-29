package ingest_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

type fixture struct {
	Account, Inbox, Contact, ContactInbox, Conversation uuid.UUID
}

func seed(t *testing.T, admin *pgx.Conn) fixture {
	t.Helper()
	ctx := context.Background()
	f := fixture{
		Account:      mustV7(t),
		Inbox:        mustV7(t),
		Contact:      mustV7(t),
		ContactInbox: mustV7(t),
		Conversation: mustV7(t),
	}
	_, err := admin.Exec(ctx, `INSERT INTO accounts (id, name) VALUES ($1, 'acme')`, f.Account)
	if err != nil {
		t.Fatal(err)
	}
	_, err = admin.Exec(ctx, `INSERT INTO inboxes (id, account_id, name, channel_type, hmac_secret)
		VALUES ($1,$2,'web','web','secret')`, f.Inbox, f.Account)
	if err != nil {
		t.Fatal(err)
	}
	_, err = admin.Exec(ctx, `INSERT INTO contacts (id, account_id, name) VALUES ($1,$2,'c')`, f.Contact, f.Account)
	if err != nil {
		t.Fatal(err)
	}
	_, err = admin.Exec(ctx, `INSERT INTO contact_inboxes (id, account_id, contact_id, inbox_id, source_id, pubsub_token)
		VALUES ($1,$2,$3,$4,'src',$5)`, f.ContactInbox, f.Account, f.Contact, f.Inbox, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	_, err = admin.Exec(ctx, `INSERT INTO conversations (id, account_id, inbox_id, contact_id, contact_inbox_id, display_id)
		VALUES ($1,$2,$3,$4,$5,1)`, f.Conversation, f.Account, f.Inbox, f.Contact, f.ContactInbox)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func mustV7(t *testing.T) uuid.UUID {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func event(t *testing.T, f fixture, msgID, conv uuid.UUID, content string) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"id":              msgID.String(),
		"schema_version":  1,
		"type":            "message_created",
		"occurred_at":     time.Now().UTC().Format(time.RFC3339),
		"account_id":      f.Account.String(),
		"inbox_id":        f.Inbox.String(),
		"conversation_id": conv.String(),
		"trace_id":        "4bf92f3577b34da6a3ce929d0e0e4736",
		"hop_count":       0,
		"payload": map[string]any{
			"content":          content,
			"message_type":     0,
			"private":          false,
			"status":           "sent",
			"content_type":     "text",
			"sender_type":      "Contact",
			"sender_id":        f.Contact.String(),
			"contact_id":       f.Contact.String(),
			"contact_inbox_id": f.ContactInbox.String(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func countMessages(t *testing.T, admin *pgx.Conn) int {
	t.Helper()
	var n int
	if err := admin.QueryRow(context.Background(), `SELECT count(*) FROM messages`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestFlush_DuplicateMessageCreatedIsIdempotent(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	fxt := seed(t, admin)
	msgID := mustV7(t)
	raw := event(t, fxt, msgID, fxt.Conversation, "hello")

	flusher := &ingest.Flusher{DB: app, JS: js}
	ack := func(context.Context) error { return nil }
	if err := flusher.Flush(ctx, []ingest.Ackable{{Data: raw, Ack: ack}, {Data: raw, Ack: ack}}); err != nil {
		t.Fatal(err)
	}
	if err := flusher.Flush(ctx, []ingest.Ackable{{Data: raw, Ack: ack}}); err != nil {
		t.Fatal(err)
	}
	if n := countMessages(t, admin); n != 1 {
		t.Fatalf("messages=%d want 1", n)
	}
}

func TestFlush_PoisonPillGoesToDLQAndGoodRowCommits(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	fxt := seed(t, admin)
	good := event(t, fxt, mustV7(t), fxt.Conversation, "ok")
	bad := event(t, fxt, mustV7(t), mustV7(t), "missing parent")

	flusher := &ingest.Flusher{DB: app, JS: js}
	ack := func(context.Context) error { return nil }
	if err := flusher.Flush(ctx, []ingest.Ackable{
		{Data: good, Ack: ack},
		{Data: bad, Ack: ack},
	}); err != nil {
		t.Fatal(err)
	}
	if n := countMessages(t, admin); n != 1 {
		t.Fatalf("messages=%d want 1", n)
	}

	stream, err := js.Stream(ctx, ingest.IngestionDLQ)
	if err != nil {
		t.Fatal(err)
	}
	got, err := stream.GetLastMsgForSubject(ctx, ingest.DLQSubject)
	if err != nil {
		t.Fatalf("dlq: %v", err)
	}
	if len(got.Data) == 0 {
		t.Fatal("empty dlq payload")
	}
}

func TestDrainOnce_PublishTwiceOneRow(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	cons, err := ingest.EnsureStreams(ctx, js)
	if err != nil {
		t.Fatal(err)
	}
	fxt := seed(t, admin)
	msgID := mustV7(t)
	raw := event(t, fxt, msgID, fxt.Conversation, "hello")
	subj := "helpdesk.events." + fxt.Account.String() + "." + fxt.Inbox.String() + "." + fxt.Conversation.String() + ".message_created"
	if _, err := js.Publish(ctx, subj, raw); err != nil {
		t.Fatal(err)
	}
	if _, err := js.Publish(ctx, subj, raw); err != nil {
		t.Fatal(err)
	}

	flusher := &ingest.Flusher{DB: app, JS: js}
	deadline := time.Now().Add(5 * time.Second)
	for countMessages(t, admin) < 1 && time.Now().Before(deadline) {
		if err := ingest.DrainOnce(ctx, cons, flusher); err != nil {
			t.Fatal(err)
		}
	}
	if n := countMessages(t, admin); n != 1 {
		t.Fatalf("messages=%d want 1", n)
	}
}
