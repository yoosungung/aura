package routing_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/routing"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestSLA_FRTBreachShowsInQueue(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedAdmin(t, admin, accountID)
	seedPolicy(t, admin, accountID, 1, 60, 3600)
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	coreSvc := &core.Service{DB: app}
	svc := &routing.Service{DB: app, Now: func() time.Time { return now }}
	created, err := coreSvc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.OnMessage(ctx, accountID, created.ConversationID, 0, false); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second)
	if err := svc.Evaluate(ctx, accountID, created.ConversationID); err != nil {
		t.Fatal(err)
	}
	list, err := coreSvc.ListConversations(ctx, core.ListInput{
		ActorUserID: adminID, AccountID: accountID, InboxIDs: []uuid.UUID{inboxID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || !list[0].SLABreached {
		t.Fatalf("%+v", list)
	}
}

func TestSLA_BusinessHoursShiftsFRT(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	if _, err := admin.Exec(ctx, `
		UPDATE inboxes SET business_hours_enabled = true, business_hours = $2::jsonb WHERE id = $1`,
		inboxID, weekdayHours()); err != nil {
		t.Fatal(err)
	}
	id := mustV7(t)
	if _, err := admin.Exec(ctx, `
		INSERT INTO sla_policies (id, account_id, name, frt_threshold_seconds, nrt_threshold_seconds, rt_threshold_seconds, only_business_hours)
		VALUES ($1,$2,'hours',$3,$4,$5,true)`, id, accountID, 2*3600, 60, 3600); err != nil {
		t.Fatal(err)
	}
	loc, err := time.LoadLocation("Asia/Seoul")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 1, 2, 17, 0, 0, 0, loc)
	coreSvc := &core.Service{DB: app}
	svc := &routing.Service{DB: app, Now: func() time.Time { return now }}
	created, err := coreSvc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.OnMessage(ctx, accountID, created.ConversationID, 0, false); err != nil {
		t.Fatal(err)
	}
	var due time.Time
	if err := admin.QueryRow(ctx, `SELECT frt_due_at FROM applied_slas WHERE conversation_id = $1`, created.ConversationID).Scan(&due); err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 1, 5, 10, 0, 0, 0, loc)
	if !due.Equal(want) {
		t.Fatalf("due %s want %s", due, want)
	}
}

func TestSLA_PendingPausesNRT(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedAdmin(t, admin, accountID)
	seedPolicy(t, admin, accountID, 60, 1, 3600)
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	coreSvc := &core.Service{DB: app}
	svc := &routing.Service{DB: app, Now: func() time.Time { return now }}
	created, err := coreSvc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.OnMessage(ctx, accountID, created.ConversationID, 0, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.OnMessage(ctx, accountID, created.ConversationID, 1, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.OnMessage(ctx, accountID, created.ConversationID, 0, false); err != nil {
		t.Fatal(err)
	}
	if _, err := coreSvc.Transition(ctx, core.TransitionInput{
		AccountID: accountID, ConversationID: created.ConversationID,
		NewStatus: core.StatusPending, ExpectedVersion: 1, ActorType: "User", ActorID: &adminID,
	}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second)
	if err := svc.Evaluate(ctx, accountID, created.ConversationID); err != nil {
		t.Fatal(err)
	}
	var nrt bool
	if err := admin.QueryRow(ctx, `SELECT is_nrt_breached FROM applied_slas WHERE conversation_id = $1`, created.ConversationID).Scan(&nrt); err != nil {
		t.Fatal(err)
	}
	if nrt {
		t.Fatal("pending nrt breached")
	}
}

func seedAdmin(t *testing.T, admin *pgx.Conn, accountID uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	userID := mustV7(t)
	digest, err := core.HashPassword("s3cret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO users (id, email, name, password_digest, pubsub_token)
		VALUES ($1,$2,'boss',$3,$4)`, userID, "boss@acme.test", digest, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO account_users (account_id, user_id, role) VALUES ($1,$2,'administrator')`, accountID, userID); err != nil {
		t.Fatal(err)
	}
	return userID
}

func seedPolicy(t *testing.T, admin *pgx.Conn, accountID uuid.UUID, frt, nrt, rt int) {
	t.Helper()
	id := mustV7(t)
	if _, err := admin.Exec(context.Background(), `
		INSERT INTO sla_policies (id, account_id, name, frt_threshold_seconds, nrt_threshold_seconds, rt_threshold_seconds, only_business_hours)
		VALUES ($1,$2,'default',$3,$4,$5,false)`, id, accountID, frt, nrt, rt); err != nil {
		t.Fatal(err)
	}
}
