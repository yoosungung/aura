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

func seedAgent(t *testing.T, admin *pgx.Conn, password string) (accountID, inboxID, userID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	accountID, inboxID = seedInbox(t, admin)
	userID, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	digest, err := core.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO users (id, email, name, password_digest, pubsub_token)
		VALUES ($1, 'ada@acme.test', 'Ada', $2, $3)`, userID, digest, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO account_users (account_id, user_id, role) VALUES ($1,$2,'agent')`, accountID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO inbox_members (account_id, inbox_id, user_id) VALUES ($1,$2,$3)`, accountID, inboxID, userID); err != nil {
		t.Fatal(err)
	}
	return accountID, inboxID, userID
}

func TestLogin_SnapshotsInboxMembers(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID, userID := seedAgent(t, admin, "s3cret")
	svc := &core.Service{DB: app}

	out, err := svc.Login(ctx, core.LoginInput{Email: "ada@acme.test", Password: "s3cret"})
	if err != nil {
		t.Fatal(err)
	}
	if out.UserID != userID || out.SessionToken == "" || out.SessionID == uuid.Nil {
		t.Fatalf("%+v", out)
	}
	if len(out.Accounts) != 1 || out.Accounts[0].AccountID != accountID || out.Accounts[0].Role != "agent" {
		t.Fatalf("accounts %+v", out.Accounts)
	}
	if len(out.Accounts[0].InboxIDs) != 1 || out.Accounts[0].InboxIDs[0] != inboxID {
		t.Fatalf("inbox_ids %+v", out.Accounts[0].InboxIDs)
	}

	var n int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id = $1`, out.SessionID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("sessions=%d", n)
	}
}

func TestLogin_WrongPassword(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	seedAgent(t, admin, "s3cret")
	svc := &core.Service{DB: app}
	_, err := svc.Login(ctx, core.LoginInput{Email: "ada@acme.test", Password: "nope"})
	if err != core.ErrUnauthorized {
		t.Fatalf("got %v", err)
	}
	_, err = svc.Login(ctx, core.LoginInput{Email: "missing@acme.test", Password: "s3cret"})
	if err != core.ErrUnauthorized {
		t.Fatalf("missing user got %v", err)
	}
}

func TestRefreshAndLogout(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID, userID := seedAgent(t, admin, "s3cret")
	svc := &core.Service{DB: app}
	logged, err := svc.Login(ctx, core.LoginInput{Email: "ada@acme.test", Password: "s3cret"})
	if err != nil {
		t.Fatal(err)
	}

	refreshed, err := svc.Refresh(ctx, logged.SessionToken)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.UserID != userID || refreshed.Accounts[0].AccountID != accountID || refreshed.Accounts[0].InboxIDs[0] != inboxID {
		t.Fatalf("%+v", refreshed)
	}

	if err := svc.Logout(ctx, logged.SessionToken); err != nil {
		t.Fatal(err)
	}
	_, err = svc.Refresh(ctx, logged.SessionToken)
	if err != core.ErrUnauthorized {
		t.Fatalf("after logout got %v", err)
	}
}

func TestAuthContact_ExchangesPubsubToken(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "widget-1", Name: "Ada",
	})
	if err != nil {
		t.Fatal(err)
	}
	var seed string
	if err := admin.QueryRow(ctx, `SELECT pubsub_token FROM contact_inboxes WHERE id = $1`, created.ContactInboxID).Scan(&seed); err != nil {
		t.Fatal(err)
	}
	out, err := svc.AuthContact(ctx, core.ContactAuthInput{InboxID: inboxID, PubsubToken: seed})
	if err != nil {
		t.Fatal(err)
	}
	if out.AccountID != accountID || out.InboxID != inboxID || out.ContactID != created.ContactID || out.ContactInboxID != created.ContactInboxID {
		t.Fatalf("%+v", out)
	}
	if out.SourceID != "widget-1" || out.ConversationID != created.ConversationID {
		t.Fatalf("%+v", out)
	}
	_, err = svc.AuthContact(ctx, core.ContactAuthInput{InboxID: inboxID, PubsubToken: "nope"})
	if err != core.ErrUnauthorized {
		t.Fatalf("got %v", err)
	}
}

func TestRPC_Login(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	_, inboxID, userID := seedAgent(t, admin, "s3cret")
	go func() {
		_ = core.Serve(ctx, nc, js, appPool(t, app))
	}()
	time.Sleep(200 * time.Millisecond)

	req, _ := json.Marshal(map[string]string{"email": "ada@acme.test", "password": "s3cret"})
	reply, err := nc.Request(core.SubjectAuthLogin, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK           bool   `json:"ok"`
		UserID       string `json:"user_id"`
		SessionID    string `json:"session_id"`
		SessionToken string `json:"session_token"`
		Accounts     []struct {
			InboxIDs []string `json:"inbox_ids"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.UserID != userID.String() || out.SessionToken == "" {
		t.Fatalf("%s", reply.Data)
	}
	if len(out.Accounts) != 1 || len(out.Accounts[0].InboxIDs) != 1 || out.Accounts[0].InboxIDs[0] != inboxID.String() {
		t.Fatalf("%s", reply.Data)
	}
}
