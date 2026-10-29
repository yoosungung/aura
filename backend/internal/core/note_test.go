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

func TestAddNote_PrivateMessage(t *testing.T) {
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

	out, err := svc.AddNote(ctx, core.NoteInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: created.ConversationID,
		Content: "환불 검토 중", TraceID: "t",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !out.Private || out.Content != "환불 검토 중" || out.MessageID == uuid.Nil {
		t.Fatalf("%+v", out)
	}
	var private bool
	var content string
	var sender uuid.UUID
	if err := admin.QueryRow(ctx, `
		SELECT private, content, sender_id FROM messages WHERE id = $1`, out.MessageID,
	).Scan(&private, &content, &sender); err != nil {
		t.Fatal(err)
	}
	if !private || content != "환불 검토 중" || sender != adminID {
		t.Fatalf("private=%v content=%s sender=%s", private, content, sender)
	}

	_, err = svc.AddNote(ctx, core.NoteInput{
		ActorUserID: agentID, AccountID: accountID, ConversationID: created.ConversationID,
		Content: "멤버 메모",
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestAddNote_RejectsOutsiderAndEmpty(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	outsider := seedUser(t, admin, accountID, "out@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.AddNote(ctx, core.NoteInput{
		ActorUserID: outsider, AccountID: accountID, ConversationID: created.ConversationID,
		Content: "몰래",
	})
	if err != core.ErrDenied {
		t.Fatalf("outsider got %v", err)
	}
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	_, err = svc.AddNote(ctx, core.NoteInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: created.ConversationID,
		Content: "  ",
	})
	if err != core.ErrInvalid {
		t.Fatalf("empty got %v", err)
	}
}

func TestRPC_AddNote(t *testing.T) {
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
		"content":         "내부 확인",
		"trace_id":        "t",
	})
	reply, err = nc.Request(core.SubjectNote, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK      bool   `json:"ok"`
		Private bool   `json:"private"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || !out.Private || out.Content != "내부 확인" {
		t.Fatalf("%s", reply.Data)
	}
}
