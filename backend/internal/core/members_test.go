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

func seedUser(t *testing.T, admin *pgx.Conn, accountID uuid.UUID, email, role, password string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
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
		VALUES ($1,$2,$3,$4,$5)`, userID, email, email, digest, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO account_users (account_id, user_id, role) VALUES ($1,$2,$3)`, accountID, userID, role); err != nil {
		t.Fatal(err)
	}
	return userID
}

func TestAddInboxMember_AdminOnly(t *testing.T) {
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
	var n int
	if err := admin.QueryRow(ctx, `
		SELECT count(*) FROM inbox_members WHERE inbox_id = $1 AND user_id = $2`, inboxID, agentID,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("members=%d", n)
	}

	if err := svc.AddInboxMember(ctx, core.MemberInput{
		ActorUserID: agentID, AccountID: accountID, InboxID: inboxID, UserID: adminID,
	}); err != core.ErrDenied {
		t.Fatalf("agent add got %v", err)
	}
}

func TestRemoveAndListInboxMembers(t *testing.T) {
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
	list, err := svc.ListInboxMembers(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: inboxID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].UserID != agentID || list[0].Email != "ada@acme.test" {
		t.Fatalf("%+v", list)
	}
	if err := svc.RemoveInboxMember(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: inboxID, UserID: agentID,
	}); err != nil {
		t.Fatal(err)
	}
	list, err = svc.ListInboxMembers(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: inboxID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("after remove %+v", list)
	}
}

func TestListAccountUsers_AdminOnly(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, _ := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}

	list, err := svc.ListAccountUsers(ctx, core.MemberInput{ActorUserID: adminID, AccountID: accountID})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("users=%d", len(list))
	}
	got := map[uuid.UUID]core.UserRow{}
	for _, row := range list {
		got[row.ID] = row
	}
	if got[agentID].Email != "ada@acme.test" || got[agentID].Role != "agent" {
		t.Fatalf("%+v", got[agentID])
	}
	if got[adminID].Role != "administrator" {
		t.Fatalf("%+v", got[adminID])
	}

	if _, err := svc.ListAccountUsers(ctx, core.MemberInput{ActorUserID: agentID, AccountID: accountID}); err != core.ErrDenied {
		t.Fatalf("agent list got %v", err)
	}
}

func TestRPC_InboxMembersAdd(t *testing.T) {
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
	go func() {
		_ = core.Serve(ctx, nc, js, appPool(t, app))
	}()
	time.Sleep(200 * time.Millisecond)

	req, _ := json.Marshal(map[string]string{
		"actor_user_id": adminID.String(),
		"account_id":    accountID.String(),
		"inbox_id":      inboxID.String(),
		"user_id":       agentID.String(),
	})
	reply, err := nc.Request(core.SubjectInboxMemberAdd, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK {
		t.Fatalf("%s", reply.Data)
	}
}

func TestRPC_AccountUsersList(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, _ := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	go func() {
		_ = core.Serve(ctx, nc, js, appPool(t, app))
	}()
	time.Sleep(200 * time.Millisecond)

	req, _ := json.Marshal(map[string]string{
		"actor_user_id": adminID.String(),
		"account_id":    accountID.String(),
	})
	reply, err := nc.Request(core.SubjectAccountUserList, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		OK    bool `json:"ok"`
		Users []struct {
			ID    string `json:"id"`
			Email string `json:"email"`
			Role  string `json:"role"`
		} `json:"users"`
	}
	if err := json.Unmarshal(reply.Data, &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || len(out.Users) != 2 {
		t.Fatalf("%s", reply.Data)
	}
	found := false
	for _, u := range out.Users {
		if u.ID == agentID.String() && u.Email == "ada@acme.test" && u.Role == "agent" {
			found = true
		}
	}
	if !found {
		t.Fatalf("%s", reply.Data)
	}
}
