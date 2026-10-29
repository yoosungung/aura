package core_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestSnooze_HidesUntilThenWakeOpens(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	until := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	out, err := svc.Snooze(ctx, core.SnoozeInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: created.ConversationID,
		Until: until, ExpectedVersion: created.Version, TraceID: "t",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != core.StatusSnoozed || out.Version != 2 || !out.SnoozedUntil.Equal(until) {
		t.Fatalf("%+v", out)
	}
	var status string
	var gotUntil *time.Time
	if err := admin.QueryRow(ctx, `
		SELECT status, snoozed_until FROM conversations WHERE id = $1`, created.ConversationID,
	).Scan(&status, &gotUntil); err != nil {
		t.Fatal(err)
	}
	if status != core.StatusSnoozed || gotUntil == nil || !gotUntil.UTC().Equal(until) {
		t.Fatalf("status=%s until=%v", status, gotUntil)
	}

	woke, err := svc.WakeDue(ctx, accountID, created.ConversationID)
	if err != nil {
		t.Fatal(err)
	}
	if woke.Status != core.StatusOpen || woke.Version != 3 {
		t.Fatalf("%+v", woke)
	}
	if err := admin.QueryRow(ctx, `
		SELECT status, snoozed_until FROM conversations WHERE id = $1`, created.ConversationID,
	).Scan(&status, &gotUntil); err != nil {
		t.Fatal(err)
	}
	if status != core.StatusOpen || gotUntil != nil {
		t.Fatalf("status=%s until=%v", status, gotUntil)
	}
}

func TestSnooze_RejectsPastAndOutsider(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	outsider := seedUser(t, admin, accountID, "out@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.Snooze(ctx, core.SnoozeInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: created.ConversationID,
		Until: time.Now().UTC().Add(-time.Minute), ExpectedVersion: 1,
	})
	if err != core.ErrInvalid {
		t.Fatalf("past got %v", err)
	}
	_, err = svc.Snooze(ctx, core.SnoozeInput{
		ActorUserID: outsider, AccountID: accountID, ConversationID: created.ConversationID,
		Until: time.Now().UTC().Add(time.Hour), ExpectedVersion: 1,
	})
	if err != core.ErrDenied {
		t.Fatalf("outsider got %v", err)
	}
}

func TestRPC_Snooze(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	go func() {
		_ = core.Serve(ctx, nc, js, appPool(t, app))
	}()
	time.Sleep(200 * time.Millisecond)

	create, _ := json.Marshal(map[string]any{
		"account_id": accountID.String(), "inbox_id": inboxID.String(), "source_id": "s", "trace_id": "t",
	})
	reply, err := nc.Request(core.SubjectCreate, create, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		OK             bool   `json:"ok"`
		ConversationID string `json:"conversation_id"`
	}
	if err := json.Unmarshal(reply.Data, &created); err != nil || !created.OK {
		t.Fatalf("create %s", reply.Data)
	}
	until := time.Now().UTC().Add(2 * time.Hour).Format(time.RFC3339)
	req, _ := json.Marshal(map[string]any{
		"actor_user_id":    adminID.String(),
		"account_id":       accountID.String(),
		"conversation_id":  created.ConversationID,
		"snoozed_until":    until,
		"expected_version": 1,
		"trace_id":         "t",
	})
	reply, err = nc.Request(core.SubjectSnooze, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK     bool   `json:"ok"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.Status != core.StatusSnoozed {
		t.Fatalf("%s", reply.Data)
	}
}

func TestSchedule_WakeConsumerOpens(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	go func() {
		_ = core.Serve(ctx, nc, js, appPool(t, app))
	}()
	time.Sleep(200 * time.Millisecond)

	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	until := time.Now().UTC().Add(2 * time.Second)
	if _, err := svc.Snooze(ctx, core.SnoozeInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: created.ConversationID,
		Until: until, ExpectedVersion: created.Version, TraceID: "t",
	}); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{
		"account_id": accountID.String(), "conversation_id": created.ConversationID.String(),
	})
	msg := &nats.Msg{
		Subject: core.SnoozeScheduleSubject(created.ConversationID),
		Header: nats.Header{
			"Nats-Schedule":        []string{"@at " + until.UTC().Format(time.RFC3339)},
			"Nats-Schedule-Target": []string{core.SnoozeWakeSubject(created.ConversationID)},
		},
		Data: payload,
	}
	if _, err := js.PublishMsg(ctx, msg); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var status string
		if err := admin.QueryRow(ctx, `SELECT status FROM conversations WHERE id = $1`, created.ConversationID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status == core.StatusOpen {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("conversation stayed snoozed")
}
