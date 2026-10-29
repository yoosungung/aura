package core_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func seedInbox(t *testing.T, admin *pgx.Conn) (accountID, inboxID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	accountID, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	inboxID, err = uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `INSERT INTO accounts (id, name) VALUES ($1, 'acme')`, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `INSERT INTO inboxes (id, account_id, name, channel_type, hmac_secret)
		VALUES ($1,$2,'web','web','secret')`, inboxID, accountID); err != nil {
		t.Fatal(err)
	}
	return accountID, inboxID
}

func appPool(t *testing.T, app *pgx.Conn) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), app.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestCreate_ConversationStartsUnassigned(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: app}
	out, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID,
		InboxID:   inboxID,
		SourceID:  "widget-1",
		Name:      "Ada",
		TraceID:   "t1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != core.StatusUnassigned || out.Version != 1 || out.DisplayID != 1 {
		t.Fatalf("%+v", out)
	}
	var status string
	var version int
	if err := admin.QueryRow(ctx, `SELECT status, version FROM conversations WHERE id = $1`, out.ConversationID).Scan(&status, &version); err != nil {
		t.Fatal(err)
	}
	if status != core.StatusUnassigned || version != 1 {
		t.Fatalf("status=%s version=%d", status, version)
	}
}

func TestTransition_ForbiddenAndConflict(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.Transition(ctx, core.TransitionInput{
		AccountID: accountID, ConversationID: created.ConversationID,
		NewStatus: core.StatusPending, ExpectedVersion: 1, TraceID: "t",
	})
	if err != core.ErrForbidden {
		t.Fatalf("got %v want forbidden", err)
	}
	_, err = svc.Transition(ctx, core.TransitionInput{
		AccountID: accountID, ConversationID: created.ConversationID,
		NewStatus: core.StatusOpen, ExpectedVersion: 99, TraceID: "t",
	})
	if err != core.ErrConflict {
		t.Fatalf("got %v want conflict", err)
	}
}

func TestTransition_ConcurrentOnlyOneWins(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	pool := appPool(t, app)
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: pool}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := svc.Transition(ctx, core.TransitionInput{
				AccountID: accountID, ConversationID: created.ConversationID,
				NewStatus: core.StatusOpen, ExpectedVersion: 1, TraceID: "t",
			})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	var wins, conflicts int
	for err := range errs {
		if err == nil {
			wins++
		} else if err == core.ErrConflict {
			conflicts++
		} else {
			t.Fatalf("unexpected %v", err)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("wins=%d conflicts=%d", wins, conflicts)
	}
	var version int
	var status string
	if err := admin.QueryRow(ctx, `SELECT status, version FROM conversations WHERE id = $1`, created.ConversationID).Scan(&status, &version); err != nil {
		t.Fatal(err)
	}
	if status != core.StatusOpen || version != 2 {
		t.Fatalf("status=%s version=%d", status, version)
	}
}

func TestRPC_CreateThenTransition(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	pool := appPool(t, app)
	go func() {
		_ = core.Serve(ctx, nc, js, pool)
	}()
	time.Sleep(200 * time.Millisecond)

	req, _ := json.Marshal(map[string]any{
		"account_id": accountID.String(),
		"inbox_id":   inboxID.String(),
		"source_id":  "widget-rpc",
		"trace_id":   "tr",
	})
	reply, err := nc.Request(core.SubjectCreate, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		OK             bool   `json:"ok"`
		ConversationID string `json:"conversation_id"`
		Version        int    `json:"version"`
	}
	if err := json.Unmarshal(reply.Data, &created); err != nil {
		t.Fatal(err)
	}
	if !created.OK {
		t.Fatalf("create %s", reply.Data)
	}

	tr, _ := json.Marshal(map[string]any{
		"account_id":       accountID.String(),
		"conversation_id":  created.ConversationID,
		"new_status":       core.StatusOpen,
		"expected_version": created.Version,
		"trace_id":         "tr",
	})
	reply, err = nc.Request(core.SubjectTransition, tr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK      bool   `json:"ok"`
		Status  string `json:"status"`
		Version int    `json:"version"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.Status != core.StatusOpen || out.Version != 2 {
		t.Fatalf("%+v %s", out, reply.Data)
	}

	reply, err = nc.Request(core.SubjectTransition, tr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if out.OK || out.Error != core.ErrConflict.Error() {
		t.Fatalf("retry want conflict got %+v", out)
	}
}
