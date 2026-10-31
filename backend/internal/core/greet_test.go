package core_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestGreet_InsertsAgentBotOnce(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	if _, err := admin.Exec(ctx, `UPDATE inboxes SET greeting_message = $2 WHERE id = $1`, inboxID, "지금은 영업시간이 아닙니다"); err != nil {
		t.Fatal(err)
	}
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	in := core.GreetInput{AccountID: accountID, ConversationID: created.ConversationID, TraceID: "t"}
	if err := svc.Greet(ctx, in); err != nil {
		t.Fatal(err)
	}
	if err := svc.Greet(ctx, in); err != nil {
		t.Fatal(err)
	}
	var n int
	var sender, content string
	var msgType int
	if err := admin.QueryRow(ctx, `
		SELECT count(*), max(sender_type), max(content), max(message_type)
		FROM messages WHERE conversation_id = $1`, created.ConversationID,
	).Scan(&n, &sender, &content, &msgType); err != nil {
		t.Fatal(err)
	}
	if n != 1 || sender != "AgentBot" || content != "지금은 영업시간이 아닙니다" || msgType != 1 {
		t.Fatalf("n=%d sender=%s content=%s type=%d", n, sender, content, msgType)
	}
}

func TestGreet_EmptyMessageNoOp(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Greet(ctx, core.GreetInput{AccountID: accountID, ConversationID: created.ConversationID}); err != nil {
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

func TestRPC_Greet(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	if _, err := admin.Exec(ctx, `UPDATE inboxes SET greeting_message = '부재중' WHERE id = $1`, inboxID); err != nil {
		t.Fatal(err)
	}
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = core.Serve(ctx, nc, js, appPool(t, app))
	}()
	time.Sleep(200 * time.Millisecond)

	req, _ := json.Marshal(map[string]string{
		"account_id": accountID.String(), "conversation_id": created.ConversationID.String(),
	})
	reply, err := nc.Request(core.SubjectGreet, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK {
		t.Fatalf("%s", reply.Data)
	}
	var n int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM messages WHERE conversation_id = $1 AND sender_type = 'AgentBot'`, created.ConversationID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("n=%d", n)
	}
}
