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

func TestListCreateDeleteInbox_AdminOnly(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}

	if _, err := svc.ListInboxes(ctx, agentID, accountID); err != core.ErrDenied {
		t.Fatalf("agent list got %v", err)
	}
	if _, err := svc.CreateInbox(ctx, core.InboxCreate{
		ActorUserID: agentID, AccountID: accountID, Name: "Web 2", ChannelType: "web",
	}); err != core.ErrDenied {
		t.Fatalf("agent create got %v", err)
	}

	list, err := svc.ListInboxes(ctx, adminID, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != inboxID || list[0].HMACSecret != "" {
		t.Fatalf("%+v", list)
	}

	created, err := svc.CreateInbox(ctx, core.InboxCreate{
		ActorUserID: adminID, AccountID: accountID, Name: "Web 2", ChannelType: "web",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Name != "Web 2" || created.ChannelType != "web" || created.HMACSecret == "" {
		t.Fatalf("%+v", created)
	}
	var member int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM inbox_members WHERE inbox_id = $1 AND user_id = $2`,
		created.ID, adminID).Scan(&member); err != nil {
		t.Fatal(err)
	}
	if member != 1 {
		t.Fatalf("member %d", member)
	}

	list, err = svc.ListInboxes(ctx, adminID, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("len %d", len(list))
	}

	if err := svc.DeleteInbox(ctx, core.MemberInput{
		ActorUserID: agentID, AccountID: accountID, InboxID: created.ID,
	}); err != core.ErrDenied {
		t.Fatalf("agent delete got %v", err)
	}
	if err := svc.DeleteInbox(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: created.ID,
	}); err != nil {
		t.Fatal(err)
	}
	list, err = svc.ListInboxes(ctx, adminID, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != inboxID {
		t.Fatalf("%+v", list)
	}
}

func TestCreateInbox_EmailAndKakao(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, _ := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}

	if _, err := svc.CreateInbox(ctx, core.InboxCreate{
		ActorUserID: adminID, AccountID: accountID, Name: "Mail", ChannelType: "email",
	}); err != core.ErrInvalid {
		t.Fatalf("email without address got %v", err)
	}
	mail, err := svc.CreateInbox(ctx, core.InboxCreate{
		ActorUserID: adminID, AccountID: accountID, Name: "Mail", ChannelType: "email",
		EmailAddress: "Support@Acme.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if mail.EmailAddress != "support@acme.test" || mail.ChannelType != "email" {
		t.Fatalf("%+v", mail)
	}
	if _, err := svc.CreateInbox(ctx, core.InboxCreate{
		ActorUserID: adminID, AccountID: accountID, Name: "Mail 2", ChannelType: "email",
		EmailAddress: "support@acme.test",
	}); err != core.ErrConflict {
		t.Fatalf("dup email got %v", err)
	}

	kakao, err := svc.CreateInbox(ctx, core.InboxCreate{
		ActorUserID: adminID, AccountID: accountID, Name: "Talk", ChannelType: "kakao",
		KakaoSenderKey: "sender-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if kakao.KakaoSenderKey != "sender-1" {
		t.Fatalf("%+v", kakao)
	}
	if _, err := svc.CreateInbox(ctx, core.InboxCreate{
		ActorUserID: adminID, AccountID: accountID, Name: "Bad", ChannelType: "social",
	}); err != core.ErrInvalid {
		t.Fatalf("social got %v", err)
	}
}

func TestUpdateInbox_NameWithoutClearingGreeting(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	name := "Support Web"
	greeting := "부재중"
	hoursOn := true
	hours := json.RawMessage(`{"timezone":"Asia/Seoul"}`)
	if _, err := svc.UpdateInbox(ctx, core.InboxUpdate{
		MemberInput:          core.MemberInput{ActorUserID: adminID, AccountID: accountID, InboxID: inboxID},
		GreetingMessage:      &greeting,
		BusinessHoursEnabled: &hoursOn,
		BusinessHours:        hours,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := svc.UpdateInbox(ctx, core.InboxUpdate{
		MemberInput: core.MemberInput{ActorUserID: adminID, AccountID: accountID, InboxID: inboxID},
		Name:        &name,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Support Web" || got.GreetingMessage != "부재중" || !got.BusinessHoursEnabled {
		t.Fatalf("%+v", got)
	}
}

func TestRPC_InboxListCreateDelete(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, _ := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	go func() {
		_ = core.Serve(ctx, nc, js, appPool(t, app))
	}()
	time.Sleep(200 * time.Millisecond)

	req, _ := json.Marshal(map[string]string{
		"actor_user_id": adminID.String(),
		"account_id":    accountID.String(),
		"name":          "Extra",
		"channel_type":  "web",
	})
	reply, err := nc.Request(core.SubjectInboxCreate, req, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		OK   bool   `json:"ok"`
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(reply.Data, &created); err != nil {
		t.Fatal(err)
	}
	if !created.OK || created.Name != "Extra" || created.ID == "" {
		t.Fatalf("%s", reply.Data)
	}

	listReq, _ := json.Marshal(map[string]string{
		"actor_user_id": adminID.String(),
		"account_id":    accountID.String(),
	})
	reply, err = nc.Request(core.SubjectInboxList, listReq, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		OK      bool `json:"ok"`
		Inboxes []struct {
			ID         string `json:"id"`
			HMACSecret string `json:"hmac_secret"`
		} `json:"inboxes"`
	}
	if err := json.Unmarshal(reply.Data, &listed); err != nil {
		t.Fatal(err)
	}
	if !listed.OK || len(listed.Inboxes) != 2 {
		t.Fatalf("%s", reply.Data)
	}
	for _, row := range listed.Inboxes {
		if row.HMACSecret != "" {
			t.Fatalf("secret leaked %s", reply.Data)
		}
	}

	del, _ := json.Marshal(map[string]string{
		"actor_user_id": adminID.String(),
		"account_id":    accountID.String(),
		"inbox_id":      created.ID,
	})
	reply, err = nc.Request(core.SubjectInboxDelete, del, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var deleted struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(reply.Data, &deleted); err != nil {
		t.Fatal(err)
	}
	if !deleted.OK {
		t.Fatalf("%s", reply.Data)
	}
}
