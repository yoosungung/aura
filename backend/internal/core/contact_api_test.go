package core_test

import (
	"context"
	"testing"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestListContactConversations_OnlyOwnInbox(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1", Name: "Ada", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w2", Name: "Bob", TraceID: "t"}); err != nil {
		t.Fatal(err)
	}
	list, err := svc.ListContactConversations(ctx, core.ContactScope{
		AccountID: accountID, InboxID: inboxID, ContactID: created.ContactID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != created.ConversationID {
		t.Fatalf("%+v", list)
	}
}

func TestListContactMessages_RejectsForeignConversation(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: app}
	a, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "a", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "b", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.ListContactMessages(ctx, core.ContactScope{
		AccountID: accountID, InboxID: inboxID, ContactID: a.ContactID, ConversationID: b.ConversationID,
	})
	if err != core.ErrDenied {
		t.Fatalf("got %v", err)
	}
}
