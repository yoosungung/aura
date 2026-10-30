package core_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestListConversations_OnlyActorInboxes(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	otherInbox, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `INSERT INTO inboxes (id, account_id, name, channel_type, hmac_secret)
		VALUES ($1,$2,'other','web','secret')`, otherInbox, accountID); err != nil {
		t.Fatal(err)
	}
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}
	if err := svc.AddInboxMember(ctx, core.MemberInput{
		ActorUserID: adminID, AccountID: accountID, InboxID: inboxID, UserID: agentID,
	}); err != nil {
		t.Fatal(err)
	}
	mine, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "w1", Name: "Ada",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: otherInbox, SourceID: "w2", Name: "Bob",
	}); err != nil {
		t.Fatal(err)
	}

	list, err := svc.ListConversations(ctx, core.ListInput{
		ActorUserID: agentID, AccountID: accountID, InboxIDs: []uuid.UUID{inboxID, otherInbox},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != mine.ConversationID {
		t.Fatalf("%+v", list)
	}
	if list[0].Channel != "web" || list[0].DisplayID == 0 {
		t.Fatalf("channel/display %+v", list[0])
	}
	if list[0].ContactName != "Ada" || list[0].LastActivityAt.IsZero() {
		t.Fatalf("contact/activity %+v", list[0])
	}
	if _, err := svc.CreateAccountLabel(ctx, core.LabelInput{
		ActorUserID: adminID, AccountID: accountID, Name: "결제",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AddConversationLabel(ctx, core.LabelInput{
		ActorUserID: agentID, AccountID: accountID, ConversationID: mine.ConversationID, Name: "결제",
	}); err != nil {
		t.Fatal(err)
	}
	labeled, err := svc.ListConversations(ctx, core.ListInput{
		ActorUserID: agentID, AccountID: accountID, InboxIDs: []uuid.UUID{inboxID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(labeled) != 1 || len(labeled[0].Labels) != 1 || labeled[0].Labels[0].Name != "결제" {
		t.Fatalf("labels %+v", labeled)
	}
}

func TestListConversations_ExcludesResolved(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	open, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "w-open", Name: "Ada",
	})
	if err != nil {
		t.Fatal(err)
	}
	done, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "w-done", Name: "Bob",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Transition(ctx, core.TransitionInput{
		AccountID: accountID, ConversationID: done.ConversationID,
		NewStatus: core.StatusResolved, ExpectedVersion: 1,
		ActorType: "User", ActorID: &adminID,
	}); err != nil {
		t.Fatal(err)
	}
	list, err := svc.ListConversations(ctx, core.ListInput{
		ActorUserID: adminID, AccountID: accountID, InboxIDs: []uuid.UUID{inboxID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != open.ConversationID || list[0].Status == core.StatusResolved {
		t.Fatalf("%+v", list)
	}
}

func TestListConversations_IncludesSLADues(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "w1", Name: "Ada",
	})
	if err != nil {
		t.Fatal(err)
	}
	policyID, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	due := created.ConversationID
	if _, err := admin.Exec(ctx, `
		INSERT INTO sla_policies (id, account_id, name, frt_threshold_seconds, nrt_threshold_seconds, rt_threshold_seconds)
		VALUES ($1,$2,'p',60,120,3600)`, policyID, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO applied_slas (account_id, conversation_id, sla_policy_id, frt_due_at)
		VALUES ($1,$2,$3, TIMESTAMPTZ '2026-10-30 06:00:00+00')`, accountID, due, policyID); err != nil {
		t.Fatal(err)
	}
	list, err := svc.ListConversations(ctx, core.ListInput{
		ActorUserID: adminID, AccountID: accountID, InboxIDs: []uuid.UUID{inboxID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].FRTDueAt == nil || list[0].FRTDueAt.UTC().Format("15:04") != "06:00" {
		t.Fatalf("sla %+v", list)
	}
}

func TestListMessagesAndContacts(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "w1", Name: "Ada",
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
		INSERT INTO messages (id, account_id, inbox_id, conversation_id, message_type, content, sender_type, sender_id)
		VALUES ($1,$2,$3,$4,0,'결제 오류','Contact',$5)`,
		msgID, accountID, inboxID, created.ConversationID, created.ContactID); err != nil {
		t.Fatal(err)
	}

	msgs, err := svc.ListMessages(ctx, core.ListInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: created.ConversationID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].Content != "결제 오류" {
		t.Fatalf("%+v", msgs)
	}

	contacts, err := svc.ListContacts(ctx, core.ListInput{
		ActorUserID: adminID, AccountID: accountID, InboxIDs: []uuid.UUID{inboxID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(contacts) != 1 || contacts[0].ID != created.ContactID || contacts[0].Name != "Ada" {
		t.Fatalf("%+v", contacts)
	}
}

func TestTransition_ActorMustBelongToInbox(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	outsider := seedUser(t, admin, accountID, "out@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "w1", Name: "Ada",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.Transition(ctx, core.TransitionInput{
		AccountID: accountID, ConversationID: created.ConversationID,
		NewStatus: core.StatusResolved, ExpectedVersion: 1,
		ActorType: "User", ActorID: &outsider,
	})
	if err != core.ErrDenied {
		t.Fatalf("got %v", err)
	}
}
