package core_test

import (
	"context"
	"testing"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestMacro_AgentForcedPersonalAndExecute(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	other := seedUser(t, admin, accountID, "bob@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}
	if err := svc.AddInboxMember(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: inboxID, UserID: agentID,
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.AddInboxMember(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: inboxID, UserID: other,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateAccountLabel(ctx, core.LabelInput{
		ActorUserID: adminID, AccountID: accountID, Name: "환불",
	}); err != nil {
		t.Fatal(err)
	}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}

	personal, err := svc.CreateMacro(ctx, core.MacroInput{
		ActorUserID: agentID, AccountID: accountID, Name: "환불 완료",
		Visibility: core.MacroVisibilityAccount,
		Actions: []core.MacroAction{
			{ActionName: core.ActionSendMessage, ActionParams: []string{"환불이 완료되었습니다."}},
			{ActionName: core.ActionAddLabel, ActionParams: []string{"환불"}},
			{ActionName: core.ActionResolve, ActionParams: []string{}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if personal.Visibility != core.MacroVisibilityPersonal {
		t.Fatalf("visibility %s", personal.Visibility)
	}

	shared, err := svc.CreateMacro(ctx, core.MacroInput{
		ActorUserID: adminID, AccountID: accountID, Name: "공유",
		Actions: []core.MacroAction{
			{ActionName: core.ActionAddPrivateNote, ActionParams: []string{"내부 확인"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if shared.Visibility != core.MacroVisibilityAccount {
		t.Fatalf("shared %s", shared.Visibility)
	}

	if _, err := svc.ExecuteMacro(ctx, core.MacroInput{
		ActorUserID: other, AccountID: accountID, ConversationID: created.ConversationID, MacroID: personal.ID,
	}); err != core.ErrDenied {
		t.Fatalf("other personal got %v", err)
	}

	out, err := svc.ExecuteMacro(ctx, core.MacroInput{
		ActorUserID: agentID, AccountID: accountID, ConversationID: created.ConversationID, MacroID: personal.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != core.StatusResolved || len(out.Messages) != 1 || out.Messages[0].Private {
		t.Fatalf("%+v", out)
	}
	if len(out.Labels) != 1 || out.Labels[0].Name != "환불" {
		t.Fatalf("labels %+v", out.Labels)
	}
	if err := svc.DeleteMacro(ctx, core.MacroInput{ActorUserID: agentID, AccountID: accountID, MacroID: shared.ID}); err != core.ErrDenied {
		t.Fatalf("agent delete got %v", err)
	}
	if err := svc.DeleteMacro(ctx, core.MacroInput{ActorUserID: adminID, AccountID: accountID, MacroID: shared.ID}); err != nil {
		t.Fatal(err)
	}
	list, err := svc.ListMacros(ctx, core.MacroInput{ActorUserID: adminID, AccountID: accountID})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := svc.UpdateMacro(ctx, core.MacroInput{
		ActorUserID: adminID, AccountID: accountID, MacroID: personal.ID, Name: "환불 안내",
		Actions: []core.MacroAction{{ActionName: core.ActionSendMessage, ActionParams: []string{"환불했습니다"}}},
	})
	if err != nil || updated.Name != "환불 안내" || len(updated.Actions) != 1 || updated.Actions[0].ActionParams[0] != "환불했습니다" {
		t.Fatalf("%+v %v", updated, err)
	}
	if _, err := svc.UpdateMacro(ctx, core.MacroInput{
		ActorUserID: agentID, AccountID: accountID, MacroID: personal.ID, Name: "막힘",
		Actions: []core.MacroAction{{ActionName: core.ActionSendMessage, ActionParams: []string{"x"}}},
	}); err != core.ErrDenied {
		t.Fatalf("agent update got %v", err)
	}
	for _, m := range list {
		if m.ID == shared.ID {
			t.Fatalf("deleted macro leaked %+v", list)
		}
	}
}

func TestMacro_RejectsUnknownAction(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, _ := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	if _, err := svc.CreateMacro(ctx, core.MacroInput{
		ActorUserID: adminID, AccountID: accountID, Name: "bad",
		Actions: []core.MacroAction{{ActionName: "mute_conversation"}},
	}); err != core.ErrInvalid {
		t.Fatalf("got %v", err)
	}
}
