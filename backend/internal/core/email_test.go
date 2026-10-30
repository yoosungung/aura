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

func seedEmailInbox(t *testing.T, admin *pgx.Conn, addr string) (uuid.UUID, uuid.UUID) {
	t.Helper()
	accountID, inboxID := seedInbox(t, admin)
	if _, err := admin.Exec(context.Background(),
		`UPDATE inboxes SET channel_type = 'email', email_address = $1 WHERE id = $2`, addr, inboxID,
	); err != nil {
		t.Fatal(err)
	}
	return accountID, inboxID
}

func TestEmailReply_SkipsWebAndReturnsThread(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	webAccount, webInbox := seedInbox(t, admin)
	adminID := seedUser(t, admin, webAccount, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	web, err := svc.Create(ctx, core.CreateInput{
		AccountID: webAccount, InboxID: webInbox, SourceID: "w1", Name: "Ada",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, skip, err := svc.EmailReply(ctx, core.ListInput{
		ActorUserID: adminID, AccountID: webAccount, ConversationID: web.ConversationID,
	})
	if err != nil || !skip {
		t.Fatalf("web skip=%v err=%v", skip, err)
	}

	accountID, inboxID := seedEmailInbox(t, admin, "support@acme.test")
	adminID = seedUser(t, admin, accountID, "mail-boss@acme.test", "administrator", "s3cret")
	created, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "ada@example.com", Name: "Ada", ReuseContact: true,
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
		VALUES ($1,$2,$3,$4,0,'결제 오류','Contact',$5,'old@x')`,
		msgID, accountID, inboxID, created.ConversationID, created.ContactID); err != nil {
		t.Fatal(err)
	}
	got, skip, err := svc.EmailReply(ctx, core.ListInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: created.ConversationID,
	})
	if err != nil || skip {
		t.Fatalf("email skip=%v err=%v", skip, err)
	}
	if got.From != "support@acme.test" || got.To != "ada@example.com" || got.DisplayID != created.DisplayID || got.InReplyTo != "old@x" {
		t.Fatalf("%+v display=%d", got, created.DisplayID)
	}
}

func TestResolveInbox_ByEmailWithoutTenantGUC(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	_, inboxID := seedEmailInbox(t, admin, "Support@acme.test")
	svc := &core.Service{DB: app}

	accountID, gotInbox, err := svc.ResolveInbox(ctx, "support@acme.test")
	if err != nil {
		t.Fatal(err)
	}
	if gotInbox != inboxID || accountID == uuid.Nil {
		t.Fatalf("account=%s inbox=%s want %s", accountID, gotInbox, inboxID)
	}
	if _, _, err := svc.ResolveInbox(ctx, "nobody@acme.test"); err != core.ErrNotFound {
		t.Fatalf("want not_found got %v", err)
	}
}

func TestCreate_ReuseContact_SameSenderTwoTickets(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedEmailInbox(t, admin, "help@acme.test")
	svc := &core.Service{DB: app}
	first, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "ada@example.com",
		Name: "Ada", TraceID: "t1", ReuseContact: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "ada@example.com",
		Name: "Ada", TraceID: "t2", ReuseContact: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.ConversationID == second.ConversationID {
		t.Fatal("want two conversations")
	}
	if first.ContactID != second.ContactID || first.ContactInboxID != second.ContactInboxID {
		t.Fatalf("want reused contact first=%+v second=%+v", first, second)
	}
	if second.DisplayID != 2 {
		t.Fatalf("display_id=%d", second.DisplayID)
	}
}

func TestResolveThread_InReplyToAndDuplicate(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedEmailInbox(t, admin, "help@acme.test")
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "ada@example.com",
		Name: "Ada", TraceID: "t1", ReuseContact: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	msgID, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO messages (
			id, account_id, inbox_id, conversation_id, message_type, content,
			private, status, source_id, content_type, sender_type, sender_id
		) VALUES ($1,$2,$3,$4,0,'hi',false,'sent','prev@mail','text','Contact',$5)`,
		msgID, accountID, inboxID, created.ConversationID, created.ContactID,
	); err != nil {
		t.Fatal(err)
	}

	out, found, dup, err := svc.ResolveThread(ctx, core.ThreadInput{
		AccountID: accountID, InboxID: inboxID, ReplyIDs: []string{"prev@mail"},
	})
	if err != nil || !found || dup {
		t.Fatalf("reply found=%v dup=%v err=%v", found, dup, err)
	}
	if out.ConversationID != created.ConversationID {
		t.Fatalf("got %s want %s", out.ConversationID, created.ConversationID)
	}

	byDisplay, found, dup, err := svc.ResolveThread(ctx, core.ThreadInput{
		AccountID: accountID, InboxID: inboxID, DisplayID: created.DisplayID,
	})
	if err != nil || !found || dup || byDisplay.ConversationID != created.ConversationID {
		t.Fatalf("display found=%v dup=%v out=%+v err=%v", found, dup, byDisplay, err)
	}

	_, found, dup, err = svc.ResolveThread(ctx, core.ThreadInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "prev@mail",
	})
	if err != nil || !found || !dup {
		t.Fatalf("duplicate found=%v dup=%v err=%v", found, dup, err)
	}

	_, found, dup, err = svc.ResolveThread(ctx, core.ThreadInput{
		AccountID: accountID, InboxID: inboxID, ReplyIDs: []string{"missing@mail"}, DisplayID: 99,
	})
	if err != nil || found || dup {
		t.Fatalf("miss found=%v dup=%v err=%v", found, dup, err)
	}
}

func TestRPC_ResolveEmailAndThread(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	accountID, inboxID := seedEmailInbox(t, admin, "support@acme.test")
	pool := appPool(t, app)
	go func() { _ = core.Serve(ctx, nc, js, pool) }()
	time.Sleep(200 * time.Millisecond)

	reply, err := nc.Request(core.SubjectInboxResolveEmail, []byte(`{"email":"support@acme.test"}`), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var resolved struct {
		OK        bool   `json:"ok"`
		AccountID string `json:"account_id"`
		InboxID   string `json:"inbox_id"`
		Error     string `json:"error"`
	}
	if err := json.Unmarshal(reply.Data, &resolved); err != nil {
		t.Fatal(err)
	}
	if !resolved.OK || resolved.AccountID != accountID.String() || resolved.InboxID != inboxID.String() {
		t.Fatalf("%s", reply.Data)
	}

	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "ada@example.com",
		TraceID: "t", ReuseContact: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"account_id": accountID.String(), "inbox_id": inboxID.String(),
		"display_id": created.DisplayID,
	})
	reply, err = nc.Request(core.SubjectResolveThread, body, 5*time.Second)
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

func TestRPC_EmailReply(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	accountID, inboxID := seedEmailInbox(t, admin, "support@acme.test")
	adminID := seedUser(t, admin, accountID, "mail-boss@acme.test", "administrator", "s3cret")
	go func() { _ = core.Serve(ctx, nc, js, appPool(t, app)) }()
	time.Sleep(200 * time.Millisecond)

	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "ada@example.com",
		Name: "Ada", TraceID: "t", ReuseContact: true,
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
		VALUES ($1,$2,$3,$4,0,'hi','Contact',$5,'old@x')`,
		msgID, accountID, inboxID, created.ConversationID, created.ContactID); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"actor_user_id": adminID.String(), "account_id": accountID.String(),
		"conversation_id": created.ConversationID.String(),
	})
	reply, err := nc.Request(core.SubjectEmailReply, body, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK        bool   `json:"ok"`
		Skip      bool   `json:"skip"`
		From      string `json:"from"`
		To        string `json:"to"`
		InReplyTo string `json:"in_reply_to"`
		DisplayID int64  `json:"display_id"`
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.Skip || out.From != "support@acme.test" || out.To != "ada@example.com" || out.InReplyTo != "old@x" || out.DisplayID != created.DisplayID {
		t.Fatalf("%s", reply.Data)
	}
}
