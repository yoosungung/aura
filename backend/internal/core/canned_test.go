package core_test

import (
	"context"
	"testing"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestCanned_AdminCreatesAgentLists(t *testing.T) {
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

	created, err := svc.CreateCanned(ctx, core.CannedInput{
		ActorUserID: adminID, AccountID: accountID, ShortCode: "인사", Content: "안녕하세요",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.ShortCode != "인사" || created.Content != "안녕하세요" {
		t.Fatalf("%+v", created)
	}
	if _, err := svc.CreateCanned(ctx, core.CannedInput{
		ActorUserID: agentID, AccountID: accountID, ShortCode: "종료", Content: "감사합니다",
	}); err != core.ErrDenied {
		t.Fatalf("agent create got %v", err)
	}
	if _, err := svc.CreateCanned(ctx, core.CannedInput{
		ActorUserID: adminID, AccountID: accountID, ShortCode: "bad code", Content: "x",
	}); err != core.ErrInvalid {
		t.Fatalf("space got %v", err)
	}
	list, err := svc.ListCanned(ctx, core.CannedInput{ActorUserID: agentID, AccountID: accountID})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ShortCode != "인사" {
		t.Fatalf("%+v", list)
	}
	if err := svc.DeleteCanned(ctx, core.CannedInput{ActorUserID: agentID, AccountID: accountID, CannedID: created.ID}); err != core.ErrDenied {
		t.Fatalf("agent delete got %v", err)
	}
	if err := svc.DeleteCanned(ctx, core.CannedInput{ActorUserID: adminID, AccountID: accountID, CannedID: created.ID}); err != nil {
		t.Fatal(err)
	}
	list, err = svc.ListCanned(ctx, core.CannedInput{ActorUserID: agentID, AccountID: accountID})
	if err != nil || len(list) != 0 {
		t.Fatalf("deleted canned leaked %+v %v", list, err)
	}
}
