package core_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
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

func TestIdentify_BadHashAndAnonymousMerge(t *testing.T) {
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
	out, err := svc.IdentifyContact(ctx, core.IdentifyInput{
		AccountID: accountID, InboxID: inboxID, ContactID: second.ContactID,
		Identifier: "user-1", IdentifierHash: identHash("secret", "user-1"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.ContactID != first.ContactID || out.Identifier != "user-1" {
		t.Fatalf("%+v want %s", out, first.ContactID)
	}
	var srcConv, tgtConv uuid.UUID
	if err := admin.QueryRow(ctx, `SELECT contact_id FROM conversations WHERE id = $1`, first.ConversationID).Scan(&tgtConv); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT contact_id FROM conversations WHERE id = $1`, second.ConversationID).Scan(&srcConv); err != nil {
		t.Fatal(err)
	}
	if tgtConv != first.ContactID || srcConv != first.ContactID {
		t.Fatalf("tickets %s %s", tgtConv, srcConv)
	}
	if first.ConversationID == second.ConversationID {
		t.Fatal("threads merged")
	}
	var mergedInto uuid.UUID
	if err := admin.QueryRow(ctx, `SELECT merged_into_contact_id FROM contacts WHERE id = $1`, second.ContactID).Scan(&mergedInto); err != nil {
		t.Fatal(err)
	}
	if mergedInto != first.ContactID {
		t.Fatalf("merged_into %s", mergedInto)
	}
	var env []byte
	if err := admin.QueryRow(ctx, `
		SELECT payload FROM event_outbox WHERE subject LIKE '%.contact_merged' ORDER BY created_at DESC LIMIT 1`,
	).Scan(&env); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Type    string `json:"type"`
		Payload struct {
			Source string `json:"source_contact_id"`
			Target string `json:"target_contact_id"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(env, &got); err != nil {
		t.Fatal(err)
	}
	if got.Type != "contact_merged" || got.Payload.Source != second.ContactID.String() || got.Payload.Target != first.ContactID.String() {
		t.Fatalf("%s", env)
	}
	again, err := svc.IdentifyContact(ctx, core.IdentifyInput{
		AccountID: accountID, InboxID: inboxID, ContactID: second.ContactID,
		Identifier: "user-1", IdentifierHash: identHash("secret", "user-1"),
	})
	if err != nil || again.ContactID != first.ContactID {
		t.Fatalf("idempotent %+v %v", again, err)
	}
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	contacts, err := svc.ListContacts(ctx, core.ListInput{
		ActorUserID: adminID, AccountID: accountID, InboxIDs: []uuid.UUID{inboxID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(contacts) != 1 || contacts[0].ID != first.ContactID {
		t.Fatalf("listed %+v", contacts)
	}
}

func TestIdentify_IdentifiedStillConflicts(t *testing.T) {
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
	second, err := svc.Create(ctx, core.CreateInput{
		AccountID: accountID, InboxID: inboxID, SourceID: "w2", Name: "Bob",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IdentifyContact(ctx, core.IdentifyInput{
		AccountID: accountID, InboxID: inboxID, ContactID: second.ContactID,
		Identifier: "user-2", IdentifierHash: identHash("secret", "user-2"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IdentifyContact(ctx, core.IdentifyInput{
		AccountID: accountID, InboxID: inboxID, ContactID: second.ContactID,
		Identifier: "user-1", IdentifierHash: identHash("secret", "user-1"),
	}); err != core.ErrConflict {
		t.Fatalf("conflict got %v", err)
	}
	var still uuid.UUID
	if err := admin.QueryRow(ctx, `SELECT contact_id FROM conversations WHERE id = $1`, second.ConversationID).Scan(&still); err != nil {
		t.Fatal(err)
	}
	if still != second.ContactID {
		t.Fatalf("moved identified ticket %s", still)
	}
}
