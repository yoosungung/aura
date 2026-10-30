package automation_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/automation"
	"github.com/yoosungung/aura/internal/contracts"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestHandle_DropsWhenHopCountOverFive(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID, convID := seedTicket(t, admin, app)
	seedLabel(t, admin, accountID, "urgent")
	seedRule(t, admin, accountID, true, `[{"attribute_key":"content","filter_operator":"contains","values":["help"]}]`,
		`[{"action_name":"add_label","action_params":["urgent"]},{"action_name":"change_priority","action_params":["high"]}]`)
	svc := &automation.Service{DB: app}
	if err := svc.Handle(ctx, envelope(accountID, inboxID, convID, 6, "please help")); err != nil {
		t.Fatal(err)
	}
	assertNoLabel(t, admin, convID, "urgent")
	assertPriority(t, admin, convID, "medium")
}

func TestHandle_AppliesLabelAndPriority(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID, convID := seedTicket(t, admin, app)
	seedLabel(t, admin, accountID, "urgent")
	seedRule(t, admin, accountID, true, `[{"attribute_key":"content","filter_operator":"contains","values":["help"]}]`,
		`[{"action_name":"add_label","action_params":["urgent"]},{"action_name":"change_priority","action_params":["high"]}]`)
	svc := &automation.Service{DB: app}
	if err := svc.Handle(ctx, envelope(accountID, inboxID, convID, 0, "please help")); err != nil {
		t.Fatal(err)
	}
	assertLabel(t, admin, convID, "urgent")
	assertPriority(t, admin, convID, "high")
}

func TestHandle_SkipsWhenConditionMisses(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID, convID := seedTicket(t, admin, app)
	seedLabel(t, admin, accountID, "urgent")
	seedRule(t, admin, accountID, true, `[{"attribute_key":"content","filter_operator":"contains","values":["help"]}]`,
		`[{"action_name":"add_label","action_params":["urgent"]}]`)
	svc := &automation.Service{DB: app}
	if err := svc.Handle(ctx, envelope(accountID, inboxID, convID, 0, "hello")); err != nil {
		t.Fatal(err)
	}
	assertNoLabel(t, admin, convID, "urgent")
}

func TestHandle_SkipsDisabledRule(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID, convID := seedTicket(t, admin, app)
	seedLabel(t, admin, accountID, "urgent")
	seedRule(t, admin, accountID, false, `[]`,
		`[{"action_name":"change_priority","action_params":["urgent"]}]`)
	svc := &automation.Service{DB: app}
	if err := svc.Handle(ctx, envelope(accountID, inboxID, convID, 0, "x")); err != nil {
		t.Fatal(err)
	}
	assertPriority(t, admin, convID, "medium")
}

func TestConsume_AppliesOnMessageCreated(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, inboxID, convID := seedTicket(t, admin, app)
	seedLabel(t, admin, accountID, "urgent")
	seedRule(t, admin, accountID, true, `[{"attribute_key":"content","filter_operator":"contains","values":["help"]}]`,
		`[{"action_name":"add_label","action_params":["urgent"]}]`)
	svc := &automation.Service{DB: app}
	go func() { _ = svc.Consume(ctx, js) }()
	time.Sleep(200 * time.Millisecond)

	msgID, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	env, err := json.Marshal(envelope(accountID, inboxID, convID, 0, "please help"))
	if err != nil {
		t.Fatal(err)
	}
	envMap := map[string]any{}
	if err := json.Unmarshal(env, &envMap); err != nil {
		t.Fatal(err)
	}
	envMap["id"] = msgID.String()
	body, err := json.Marshal(envMap)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.Publish(ctx, "helpdesk.events."+accountID.String()+"."+inboxID.String()+"."+convID.String()+".message_created", body); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		if err := admin.QueryRow(ctx, `
			SELECT COUNT(*) FROM conversation_labels cl
			JOIN labels l ON l.id = cl.label_id
			WHERE cl.conversation_id = $1 AND l.name = 'urgent'`, convID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 1 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("label not applied")
}

func seedTicket(t *testing.T, admin *pgx.Conn, app *pgx.Conn) (accountID, inboxID, convID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	accountID, inboxID = mustV7(t), mustV7(t)
	if _, err := admin.Exec(ctx, `INSERT INTO accounts (id, name) VALUES ($1, 'acme')`, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `INSERT INTO inboxes (id, account_id, name, channel_type, hmac_secret)
		VALUES ($1,$2,'web','web','secret')`, inboxID, accountID); err != nil {
		t.Fatal(err)
	}
	out, err := (&core.Service{DB: app}).Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "w1"})
	if err != nil {
		t.Fatal(err)
	}
	return accountID, inboxID, out.ConversationID
}

func seedLabel(t *testing.T, admin *pgx.Conn, accountID uuid.UUID, name string) {
	t.Helper()
	if _, err := admin.Exec(context.Background(), `INSERT INTO labels (id, account_id, name) VALUES ($1,$2,$3)`,
		mustV7(t), accountID, name); err != nil {
		t.Fatal(err)
	}
}

func seedRule(t *testing.T, admin *pgx.Conn, accountID uuid.UUID, enabled bool, conditions, actions string) {
	t.Helper()
	if _, err := admin.Exec(context.Background(), `
		INSERT INTO automation_rules (id, account_id, name, event_name, conditions, actions, enabled)
		VALUES ($1,$2,'rule','message_created',$3::jsonb,$4::jsonb,$5)`,
		mustV7(t), accountID, conditions, actions, enabled); err != nil {
		t.Fatal(err)
	}
}

func envelope(accountID, inboxID, convID uuid.UUID, hop int, content string) contracts.MessageCreated {
	return contracts.MessageCreated{
		ID: mustV7ID(), SchemaVersion: 1, Type: "message_created",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		AccountID:  accountID.String(), InboxID: inboxID.String(), ConversationID: convID.String(),
		TraceID: "t", HopCount: hop,
		Payload: contracts.MessageCreatedPayload{
			Content: content, MessageType: 0, Status: "sent", ContentType: "text",
			SenderType: "Contact", SenderID: mustV7ID(), ContactID: mustV7ID(), ContactInboxID: mustV7ID(),
		},
	}
}

func assertLabel(t *testing.T, admin *pgx.Conn, convID uuid.UUID, name string) {
	t.Helper()
	var n int
	if err := admin.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM conversation_labels cl
		JOIN labels l ON l.id = cl.label_id
		WHERE cl.conversation_id = $1 AND l.name = $2`, convID, name).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("label %s count %d", name, n)
	}
}

func assertNoLabel(t *testing.T, admin *pgx.Conn, convID uuid.UUID, name string) {
	t.Helper()
	var n int
	if err := admin.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM conversation_labels cl
		JOIN labels l ON l.id = cl.label_id
		WHERE cl.conversation_id = $1 AND l.name = $2`, convID, name).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("label %s count %d", name, n)
	}
}

func assertPriority(t *testing.T, admin *pgx.Conn, convID uuid.UUID, want string) {
	t.Helper()
	var got string
	if err := admin.QueryRow(context.Background(), `SELECT priority FROM conversations WHERE id = $1`, convID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("priority %s want %s", got, want)
	}
}

func mustV7(t *testing.T) uuid.UUID {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func mustV7ID() string {
	id, err := uuid.NewV7()
	if err != nil {
		panic(err)
	}
	return id.String()
}
