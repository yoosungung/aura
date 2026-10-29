package core_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func putMember(t *testing.T, admin *pgx.Conn, accountID, inboxID, userID uuid.UUID) {
	t.Helper()
	if _, err := admin.Exec(context.Background(), `
		INSERT INTO inbox_members (account_id, inbox_id, user_id) VALUES ($1,$2,$3)`,
		accountID, inboxID, userID); err != nil {
		t.Fatal(err)
	}
}

func TestAssign_AdminSetsInboxMemberAndOpens(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	putMember(t, admin, accountID, inboxID, agentID)
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}

	out, err := svc.Assign(ctx, core.AssignInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: created.ConversationID,
		AssigneeID: agentID, ExpectedVersion: created.Version, TraceID: "t",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != core.StatusOpen || out.Version != 2 || out.AssigneeID != agentID {
		t.Fatalf("%+v", out)
	}
	var status string
	var assignee uuid.UUID
	var version int
	if err := admin.QueryRow(ctx, `
		SELECT status, assignee_id, version FROM conversations WHERE id = $1`, created.ConversationID,
	).Scan(&status, &assignee, &version); err != nil {
		t.Fatal(err)
	}
	if status != core.StatusOpen || assignee != agentID || version != 2 {
		t.Fatalf("status=%s assignee=%s version=%d", status, assignee, version)
	}
}

func TestAssign_RejectsNonMemberAndConflict(t *testing.T) {
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
	_, err = svc.Assign(ctx, core.AssignInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: created.ConversationID,
		AssigneeID: outsider, ExpectedVersion: 1, TraceID: "t",
	})
	if err != core.ErrDenied {
		t.Fatalf("outsider got %v", err)
	}
	_, err = svc.Assign(ctx, core.AssignInput{
		ActorUserID: outsider, AccountID: accountID, ConversationID: created.ConversationID,
		AssigneeID: outsider, ExpectedVersion: 1, TraceID: "t",
	})
	if err != core.ErrDenied {
		t.Fatalf("actor outsider got %v", err)
	}
}

func TestAssign_AgentMemberCanAssign(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	otherID := seedUser(t, admin, accountID, "bob@acme.test", "agent", "s3cret")
	putMember(t, admin, accountID, inboxID, agentID)
	putMember(t, admin, accountID, inboxID, otherID)
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	out, err := svc.Assign(ctx, core.AssignInput{
		ActorUserID: agentID, AccountID: accountID, ConversationID: created.ConversationID,
		AssigneeID: otherID, ExpectedVersion: 1, TraceID: "t",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.AssigneeID != otherID || out.Status != core.StatusOpen {
		t.Fatalf("%+v", out)
	}
	_, err = svc.Assign(ctx, core.AssignInput{
		ActorUserID: agentID, AccountID: accountID, ConversationID: created.ConversationID,
		AssigneeID: otherID, ExpectedVersion: 1, TraceID: "t",
	})
	if err != core.ErrConflict {
		t.Fatalf("stale version got %v", err)
	}
}

func TestRPC_Assign(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	putMember(t, admin, accountID, inboxID, agentID)
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

	req, _ := json.Marshal(map[string]any{
		"actor_user_id":    adminID.String(),
		"account_id":       accountID.String(),
		"conversation_id":  created.ConversationID,
		"assignee_id":      agentID.String(),
		"expected_version": 1,
		"trace_id":         "t",
	})
	reply, err = nc.Request(core.SubjectAssign, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK         bool   `json:"ok"`
		Status     string `json:"status"`
		AssigneeID string `json:"assignee_id"`
		Version    int    `json:"version"`
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.Status != core.StatusOpen || out.AssigneeID != agentID.String() || out.Version != 2 {
		t.Fatalf("%s", reply.Data)
	}
}
