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

func TestGetInboxHMAC_AdminOnly(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}

	got, err := svc.GetInbox(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: inboxID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != inboxID || got.HMACSecret != "secret" || got.ChannelType != "web" {
		t.Fatalf("%+v", got)
	}

	if _, err := svc.GetInbox(ctx, core.MemberInput{
		ActorUserID: agentID, AccountID: accountID, InboxID: inboxID,
	}); err != core.ErrDenied {
		t.Fatalf("agent get got %v", err)
	}
}

func TestRotateInboxHMAC_Overwrites(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}

	if _, err := svc.RotateHMAC(ctx, core.MemberInput{
		ActorUserID: agentID, AccountID: accountID, InboxID: inboxID,
	}); err != core.ErrDenied {
		t.Fatalf("agent rotate got %v", err)
	}

	first, err := svc.RotateHMAC(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: inboxID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.HMACSecret == "" || first.HMACSecret == "secret" || len(first.HMACSecret) != 64 {
		t.Fatalf("secret %q", first.HMACSecret)
	}
	second, err := svc.RotateHMAC(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: inboxID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.HMACSecret == first.HMACSecret {
		t.Fatal("rotate reused secret")
	}
	got, err := svc.GetInbox(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: inboxID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.HMACSecret != second.HMACSecret {
		t.Fatalf("stored %q want %q", got.HMACSecret, second.HMACSecret)
	}
}

func TestRPC_InboxGetAndRotateHMAC(t *testing.T) {
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

	req, _ := json.Marshal(map[string]string{
		"actor_user_id": adminID.String(),
		"account_id":    accountID.String(),
		"inbox_id":      inboxID.String(),
	})
	reply, err := nc.Request(core.SubjectInboxGet, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		OK         bool   `json:"ok"`
		HMACSecret string `json:"hmac_secret"`
	}
	if err := json.Unmarshal(reply.Data, &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.HMACSecret != "secret" {
		t.Fatalf("%s", reply.Data)
	}

	reply, err = nc.Request(core.SubjectInboxRotateHMAC, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(reply.Data, &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.HMACSecret == "" || got.HMACSecret == "secret" {
		t.Fatalf("%s", reply.Data)
	}
}

func TestUpdateInbox_GreetingAndHours(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}
	hours := json.RawMessage(`{"timezone":"Asia/Seoul","week":{"mon":[["09:00","18:00"]]}}`)

	if _, err := svc.UpdateInbox(ctx, core.InboxUpdate{
		MemberInput: core.MemberInput{ActorUserID: agentID, AccountID: accountID, InboxID: inboxID},
		GreetingMessage: "hi", BusinessHoursEnabled: true, BusinessHours: hours,
	}); err != core.ErrDenied {
		t.Fatalf("agent update got %v", err)
	}

	got, err := svc.UpdateInbox(ctx, core.InboxUpdate{
		MemberInput:          core.MemberInput{ActorUserID: adminID, AccountID: accountID, InboxID: inboxID},
		GreetingMessage:      "부재중입니다",
		BusinessHoursEnabled: true,
		BusinessHours:        hours,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.GreetingMessage != "부재중입니다" || !got.BusinessHoursEnabled {
		t.Fatalf("%+v", got)
	}
	stored, err := svc.GetInbox(ctx, core.MemberInput{ActorUserID: adminID, AccountID: accountID, InboxID: inboxID})
	if err != nil {
		t.Fatal(err)
	}
	if stored.GreetingMessage != "부재중입니다" || !stored.BusinessHoursEnabled {
		t.Fatalf("%+v", stored)
	}
}
