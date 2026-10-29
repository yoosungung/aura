package core_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func identHash(secret, identifier string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(identifier))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestIdentify_ValidHMACSetsIdentifier(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: app}
	created, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "w1", Name: "Guest",
	})
	if err != nil {
		t.Fatal(err)
	}
	out, err := svc.IdentifyContact(ctx, core.IdentifyInput{
		AccountID: accountID, InboxID: inboxID, ContactID: created.ContactID,
		Identifier: "user-1", IdentifierHash: identHash("secret", "user-1"), Name: "Ada",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Identifier != "user-1" || out.Name != "Ada" {
		t.Fatalf("%+v", out)
	}
}

func TestIdentify_BadHashAndConflict(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	svc := &core.Service{DB: app}
	first, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "w1", Name: "Ada",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IdentifyContact(ctx, core.IdentifyInput{
		AccountID: accountID, InboxID: inboxID, ContactID: first.ContactID,
		Identifier: "user-1", IdentifierHash: identHash("secret", "user-1"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IdentifyContact(ctx, core.IdentifyInput{
		AccountID: accountID, InboxID: inboxID, ContactID: first.ContactID,
		Identifier: "user-1", IdentifierHash: "deadbeef",
	}); err != core.ErrUnauthorized {
		t.Fatalf("bad hash got %v", err)
	}
	second, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "w2", Name: "Bob",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IdentifyContact(ctx, core.IdentifyInput{
		AccountID: accountID, InboxID: inboxID, ContactID: second.ContactID,
		Identifier: "user-1", IdentifierHash: identHash("secret", "user-1"),
	}); err != core.ErrConflict {
		t.Fatalf("conflict got %v", err)
	}
}
