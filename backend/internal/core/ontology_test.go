package core_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestTransition_ResolvedPublishesOntologyExtract(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: app, JS: js}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	cons, err := js.CreateOrUpdateConsumer(ctx, ingest.TasksStream, ingest.OntologyExtractConsumerConfig())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Transition(ctx, core.TransitionInput{
		AccountID: accountID, ConversationID: created.ConversationID,
		NewStatus: core.StatusResolved, ExpectedVersion: 1, TraceID: "t",
	}); err != nil {
		t.Fatal(err)
	}
	got := fetchOne(t, cons)
	var payload map[string]any
	if err := json.Unmarshal(got.Data(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["contact_id"] != created.ContactID.String() || payload["conversation_id"] != created.ConversationID.String() {
		t.Fatalf("%v", payload)
	}
	_ = got.Ack()
}

func fetchOne(t *testing.T, cons jetstream.Consumer) jetstream.Msg {
	t.Helper()
	batch, err := cons.Fetch(1, jetstream.FetchMaxWait(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	msg, ok := <-batch.Messages()
	if !ok || msg == nil {
		if err := batch.Error(); err != nil {
			t.Fatal(err)
		}
		t.Fatal("no message")
	}
	return msg
}
