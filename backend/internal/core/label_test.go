package core_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestLabel_AttachByNameSharesCatalog(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	a, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "a", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "b", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}

	first, err := svc.AddConversationLabel(ctx, core.LabelInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: a.ConversationID, Name: "환불",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Name != "환불" || first.ID == uuid.Nil {
		t.Fatalf("%+v", first)
	}
	second, err := svc.AddConversationLabel(ctx, core.LabelInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: b.ConversationID, Name: "환불",
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID {
		t.Fatalf("catalog %s vs %s", first.ID, second.ID)
	}
	list, err := svc.ListConversationLabels(ctx, core.LabelInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: a.ConversationID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Name != "환불" {
		t.Fatalf("%+v", list)
	}
	if err := svc.RemoveConversationLabel(ctx, core.LabelInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: a.ConversationID, LabelID: first.ID,
	}); err != nil {
		t.Fatal(err)
	}
	empty, err := svc.ListConversationLabels(ctx, core.LabelInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: a.ConversationID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("%+v", empty)
	}
	var n int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM labels WHERE id = $1`, first.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("catalog deleted n=%d", n)
	}
}

func TestLabel_AgentCannotCreateMissingName(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}
	if err := svc.AddInboxMember(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: inboxID, UserID: agentID,
	}); err != nil {
		t.Fatal(err)
	}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AddConversationLabel(ctx, core.LabelInput{
		ActorUserID: agentID, AccountID: accountID, ConversationID: created.ConversationID, Name: "환불",
	}); err != core.ErrNotFound {
		t.Fatalf("missing catalog got %v", err)
	}
	if _, err := svc.CreateAccountLabel(ctx, core.LabelInput{
		ActorUserID: agentID, AccountID: accountID, Name: "환불",
	}); err != core.ErrDenied {
		t.Fatalf("agent catalog got %v", err)
	}
	cat, err := svc.CreateAccountLabel(ctx, core.LabelInput{
		ActorUserID: adminID, AccountID: accountID, Name: "환불",
	})
	if err != nil {
		t.Fatal(err)
	}
	attached, err := svc.AddConversationLabel(ctx, core.LabelInput{
		ActorUserID: agentID, AccountID: accountID, ConversationID: created.ConversationID, Name: "환불",
	})
	if err != nil {
		t.Fatal(err)
	}
	if attached.ID != cat.ID {
		t.Fatalf("%s vs %s", attached.ID, cat.ID)
	}
	list, err := svc.ListAccountLabels(ctx, core.LabelInput{ActorUserID: agentID, AccountID: accountID})
	if err != nil || len(list) != 1 {
		t.Fatalf("%+v %v", list, err)
	}
	if err := svc.DeleteAccountLabel(ctx, core.LabelInput{ActorUserID: agentID, AccountID: accountID, LabelID: cat.ID}); err != core.ErrDenied {
		t.Fatalf("agent delete got %v", err)
	}
	if err := svc.DeleteAccountLabel(ctx, core.LabelInput{ActorUserID: adminID, AccountID: accountID, LabelID: cat.ID}); err != nil {
		t.Fatal(err)
	}
	list, err = svc.ListAccountLabels(ctx, core.LabelInput{ActorUserID: agentID, AccountID: accountID})
	if err != nil || len(list) != 0 {
		t.Fatalf("deleted label leaked %+v %v", list, err)
	}
}

func TestLabel_RejectsBlankAndOutsider(t *testing.T) {
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
	_, err = svc.AddConversationLabel(ctx, core.LabelInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: created.ConversationID, Name: "  ",
	})
	if err != core.ErrInvalid {
		t.Fatalf("blank got %v", err)
	}
	_, err = svc.AddConversationLabel(ctx, core.LabelInput{
		ActorUserID: outsider, AccountID: accountID, ConversationID: created.ConversationID, Name: "환불",
	})
	if err != core.ErrDenied {
		t.Fatalf("outsider got %v", err)
	}
}

func TestRPC_Label(t *testing.T) {
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
	req, _ := json.Marshal(map[string]any{
		"actor_user_id":   adminID.String(),
		"account_id":      accountID.String(),
		"conversation_id": created.ConversationID,
		"name":            "환불",
	})
	reply, err = nc.Request(core.SubjectLabelAdd, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK   bool   `json:"ok"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.Name != "환불" {
		t.Fatalf("%s", reply.Data)
	}
}
