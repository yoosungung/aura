package automation_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/yoosungung/aura/internal/automation"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestHandle_SendWebhookEnqueuesDeliver(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	nc, js := testutil.NATSConn(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, inboxID, convID := seedTicket(t, admin, app)
	hookID := mustV7(t)
	seedRule(t, admin, accountID, true, `[]`,
		`[{"action_name":"send_webhook","action_params":["`+hookID.String()+`"]}]`)
	sub, err := nc.SubscribeSync(ingest.WebhookDeliverSubject)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sub.Unsubscribe() })
	svc := &automation.Service{DB: app, JS: js}
	if err := svc.Handle(ctx, envelope(accountID, inboxID, convID, 0, "hi")); err != nil {
		t.Fatal(err)
	}
	msg, err := sub.NextMsg(2 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var task struct {
		WebhookID string `json:"webhook_id"`
	}
	if err := json.Unmarshal(msg.Data, &task); err != nil {
		t.Fatal(err)
	}
	if task.WebhookID != hookID.String() {
		t.Fatalf("%+v", task)
	}
}
