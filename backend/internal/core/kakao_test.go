package core_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func seedKakaoInbox(t *testing.T, admin *pgx.Conn, senderKey string) (uuid.UUID, uuid.UUID) {
	t.Helper()
	accountID, inboxID := seedInbox(t, admin)
	if _, err := admin.Exec(context.Background(),
		`UPDATE inboxes SET channel_type = 'kakao', kakao_sender_key = $1 WHERE id = $2`, senderKey, inboxID,
	); err != nil {
		t.Fatal(err)
	}
	return accountID, inboxID
}

func TestResolveKakaoInbox_BySenderKeyWithoutTenantGUC(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	_, inboxID := seedKakaoInbox(t, admin, "sender-acme")
	svc := &core.Service{DB: app}

	accountID, gotInbox, err := svc.ResolveKakaoInbox(ctx, "sender-acme")
	if err != nil {
		t.Fatal(err)
	}
	if gotInbox != inboxID || accountID == uuid.Nil {
		t.Fatalf("account=%s inbox=%s want %s", accountID, gotInbox, inboxID)
	}
	if _, _, err := svc.ResolveKakaoInbox(ctx, "missing"); err != core.ErrNotFound {
		t.Fatalf("want not_found got %v", err)
	}
}

func TestResolveKakao_DuplicateAndOpenThread(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedKakaoInbox(t, admin, "sender-acme")
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "user-ada",
		Name: "Ada", TraceID: "t1", ReuseContact: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	msgID, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, accountID.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO messages (id, account_id, inbox_id, conversation_id, message_type, content, sender_type, sender_id, source_id)
		VALUES ($1,$2,$3,$4,0,'hi','Contact',$5,'msg-1')`,
		msgID, accountID, inboxID, created.ConversationID, created.ContactID); err != nil {
		t.Fatal(err)
	}

	out, found, dup, err := svc.ResolveKakao(ctx, core.KakaoInput{
		AccountID: accountID, InboxID: inboxID, MsgKey: "other", UserKey: "user-ada",
	})
	if err != nil || !found || dup || out.ConversationID != created.ConversationID {
		t.Fatalf("open found=%v dup=%v out=%+v err=%v", found, dup, out, err)
	}

	_, found, dup, err = svc.ResolveKakao(ctx, core.KakaoInput{
		AccountID: accountID, InboxID: inboxID, MsgKey: "msg-1", UserKey: "user-ada",
	})
	if err != nil || !found || !dup {
		t.Fatalf("dup found=%v dup=%v err=%v", found, dup, err)
	}

	if _, err := svc.Transition(ctx, core.TransitionInput{
		AccountID: accountID, ConversationID: created.ConversationID,
		NewStatus: core.StatusResolved, ExpectedVersion: created.Version, TraceID: "t",
	}); err != nil {
		t.Fatal(err)
	}
	_, found, dup, err = svc.ResolveKakao(ctx, core.KakaoInput{
		AccountID: accountID, InboxID: inboxID, MsgKey: "msg-2", UserKey: "user-ada",
	})
	if err != nil || found || dup {
		t.Fatalf("resolved found=%v dup=%v err=%v", found, dup, err)
	}
}

func TestRPC_ResolveKakao(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	accountID, inboxID := seedKakaoInbox(t, admin, "sender-acme")
	go func() { _ = core.Serve(ctx, nc, js, appPool(t, app)) }()
	time.Sleep(200 * time.Millisecond)

	reply, err := nc.Request(core.SubjectInboxResolveKakao, []byte(`{"sender_key":"sender-acme"}`), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var resolved struct {
		OK        bool   `json:"ok"`
		AccountID string `json:"account_id"`
		InboxID   string `json:"inbox_id"`
	}
	if err := json.Unmarshal(reply.Data, &resolved); err != nil {
		t.Fatal(err)
	}
	if !resolved.OK || resolved.AccountID != accountID.String() || resolved.InboxID != inboxID.String() {
		t.Fatalf("%s", reply.Data)
	}

	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "user-ada",
		TraceID: "t", ReuseContact: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"account_id": accountID.String(), "inbox_id": inboxID.String(),
		"source_id": "msg-new", "user_key": "user-ada",
	})
	reply, err = nc.Request(core.SubjectResolveKakao, body, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var thread struct {
		OK             bool   `json:"ok"`
		Found          bool   `json:"found"`
		Duplicate      bool   `json:"duplicate"`
		ConversationID string `json:"conversation_id"`
	}
	if err := json.Unmarshal(reply.Data, &thread); err != nil {
		t.Fatal(err)
	}
	if !thread.OK || !thread.Found || thread.ConversationID != created.ConversationID.String() {
		t.Fatalf("%s", reply.Data)
	}
}
