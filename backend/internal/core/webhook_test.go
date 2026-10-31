package core_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/contracts"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestCreateWebhook_AdminOnly(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	_ = inboxID
	svc := &core.Service{DB: app}
	got, err := svc.CreateWebhook(ctx, core.WebhookInput{
		ActorUserID: adminID, AccountID: accountID,
		URL: "https://crm.example/hook", Subscriptions: []string{"message_created"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID == uuid.Nil || got.Secret == "" || got.URL != "https://crm.example/hook" {
		t.Fatalf("%+v", got)
	}
	_, err = svc.CreateWebhook(ctx, core.WebhookInput{
		ActorUserID: agentID, AccountID: accountID, URL: "https://crm.example/other",
	})
	if err != core.ErrDenied {
		t.Fatalf("agent got %v", err)
	}
	updated, err := svc.UpdateWebhook(ctx, core.WebhookInput{
		ActorUserID: adminID, AccountID: accountID, WebhookID: got.ID,
		URL: "https://crm.example/v2", Subscriptions: []string{"message_created"},
	})
	if err != nil || updated.URL != "https://crm.example/v2" || updated.Secret != got.Secret {
		t.Fatalf("%+v %v", updated, err)
	}
	if _, err := svc.UpdateWebhook(ctx, core.WebhookInput{
		ActorUserID: agentID, AccountID: accountID, WebhookID: got.ID, URL: "https://crm.example/nope",
	}); err != core.ErrDenied {
		t.Fatalf("agent update got %v", err)
	}
}

func TestDeliverWebhook_SignsPayload(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	hook, err := svc.CreateWebhook(ctx, core.WebhookInput{
		ActorUserID: adminID, AccountID: accountID,
		URL: "https://example.invalid", Subscriptions: []string{"message_created"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var gotSig, gotTS, gotBody string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSig = r.Header.Get("X-Helpdesk-Signature")
		gotTS = r.Header.Get("X-Helpdesk-Timestamp")
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)
	if _, err := admin.Exec(ctx, `UPDATE webhooks SET url = $2 WHERE id = $1`, hook.ID, ts.URL); err != nil {
		t.Fatal(err)
	}
	env := contracts.MessageCreated{
		ID: mustID(t), SchemaVersion: 1, Type: "message_created",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		AccountID:  accountID.String(), InboxID: inboxID.String(), ConversationID: mustID(t),
		TraceID: "trace",
		Payload: contracts.MessageCreatedPayload{Content: "hi", SenderType: "Contact", Status: "sent"},
	}
	if err := svc.DeliverWebhook(ctx, core.DeliverInput{WebhookID: hook.ID, AccountID: accountID, Event: env}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(gotSig, "sha256=") || gotTS == "" {
		t.Fatalf("sig=%s ts=%s", gotSig, gotTS)
	}
	mac := hmac.New(sha256.New, []byte(hook.Secret))
	_, _ = mac.Write([]byte(gotTS + "." + gotBody))
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if gotSig != want {
		t.Fatalf("sig %s want %s body=%s", gotSig, want, gotBody)
	}
	var pub struct {
		Event   string `json:"event"`
		Payload struct {
			Content string `json:"content"`
		} `json:"payload"`
	}
	if err := json.Unmarshal([]byte(gotBody), &pub); err != nil {
		t.Fatal(err)
	}
	if pub.Event != "message_created" || pub.Payload.Content != "hi" {
		t.Fatalf("%+v", pub)
	}
	unix, err := strconv.ParseInt(gotTS, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if d := time.Since(time.Unix(unix, 0)); d > 2*time.Minute || d < -2*time.Minute {
		t.Fatalf("timestamp skew %s", d)
	}
}

func TestFanoutWebhooks_EnqueuesSubscribed(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app, JS: js, NC: nc}
	hook, err := svc.CreateWebhook(ctx, core.WebhookInput{
		ActorUserID: adminID, AccountID: accountID,
		URL: "https://crm.example/hook", Subscriptions: []string{"message_created"},
	})
	if err != nil {
		t.Fatal(err)
	}
	sub, err := nc.SubscribeSync(ingest.WebhookDeliverSubject)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sub.Unsubscribe() })
	env := contracts.MessageCreated{
		ID: mustID(t), SchemaVersion: 1, Type: "message_created",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		AccountID:  accountID.String(), InboxID: inboxID.String(), ConversationID: mustID(t),
		TraceID: "t",
	}
	if err := svc.FanoutWebhooks(ctx, env); err != nil {
		t.Fatal(err)
	}
	msg, err := sub.NextMsg(2 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var task struct {
		WebhookID string `json:"webhook_id"`
		AccountID string `json:"account_id"`
	}
	if err := json.Unmarshal(msg.Data, &task); err != nil {
		t.Fatal(err)
	}
	if task.WebhookID != hook.ID.String() || task.AccountID != accountID.String() {
		t.Fatalf("%+v", task)
	}
}

func TestDeliverWebhook_RetriesOnServerError(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, _ := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	hook, err := svc.CreateWebhook(ctx, core.WebhookInput{
		ActorUserID: adminID, AccountID: accountID, URL: "https://example.invalid",
	})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(ts.Close)
	if _, err := admin.Exec(ctx, `UPDATE webhooks SET url = $2 WHERE id = $1`, hook.ID, ts.URL); err != nil {
		t.Fatal(err)
	}
	err = svc.DeliverWebhook(ctx, core.DeliverInput{
		WebhookID: hook.ID, AccountID: accountID,
		Event: contracts.MessageCreated{ID: mustID(t), Type: "message_created", AccountID: accountID.String()},
	})
	if err != core.ErrWebhookRetry {
		t.Fatalf("got %v", err)
	}
}

func mustID(t *testing.T) string {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	return id.String()
}
