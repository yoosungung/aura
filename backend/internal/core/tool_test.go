package core_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/ingest"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestApproveTool_PublishesExecuteTask(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	js := testutil.NATS(t)
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		t.Fatal(err)
	}
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app, JS: js}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	execID := mustV7(t)
	if _, err := admin.Exec(ctx, `
		INSERT INTO agent_tool_executions (id, account_id, conversation_id, tool_name, input_args, output_result, is_success, requires_approval)
		VALUES ($1,$2,$3,'refund','{"amount":1}'::jsonb,'{}'::jsonb,false,true)`,
		execID, accountID, created.ConversationID); err != nil {
		t.Fatal(err)
	}
	cons, err := js.Consumer(ctx, ingest.TasksStream, ingest.AIExecuteConsumer)
	if err != nil {
		t.Fatal(err)
	}
	out, err := svc.ApproveTool(ctx, core.ApproveInput{
		ActorUserID: adminID, AccountID: accountID, ConversationID: created.ConversationID, ExecutionID: execID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.ToolName != "refund" {
		t.Fatalf("%+v", out)
	}
	got := fetchOne(t, cons)
	var payload map[string]any
	if err := json.Unmarshal(got.Data(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["execution_id"] != execID.String() {
		t.Fatalf("%v", payload)
	}
	_ = got.Ack()
}

type recArchive struct{ prefixes []string }

func (r *recArchive) DeletePrefix(_ context.Context, prefix string) error {
	r.prefixes = append(r.prefixes, prefix)
	return nil
}

func TestPurgeContact_AdminOnly(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	store := &recArchive{}
	svc := &core.Service{DB: app, Archive: store}
	created, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "s", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.PurgeContact(ctx, core.PurgeInput{ActorUserID: agentID, AccountID: accountID, ContactID: created.ContactID}); err != core.ErrDenied {
		t.Fatalf("agent %v", err)
	}
	if _, err := admin.Exec(ctx, `
		UPDATE contacts SET email='ada@acme.test', phone_number='010-0000-0000', identifier='ada'
		WHERE id=$1`, created.ContactID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO messages (id, account_id, inbox_id, conversation_id, message_type, content, sender_type, sender_id)
		VALUES ($1,$2,$3,$4,0,'환불 계좌는 주민번호','Contact',$5)`,
		mustV7(t), accountID, inboxID, created.ConversationID, created.ContactID); err != nil {
		t.Fatal(err)
	}
	if err := svc.PurgeContact(ctx, core.PurgeInput{ActorUserID: adminID, AccountID: accountID, ContactID: created.ContactID}); err != nil {
		t.Fatal(err)
	}
	if len(store.prefixes) != 1 || store.prefixes[0] != accountID.String()+"/"+created.ConversationID.String()+"/" {
		t.Fatalf("archive prefixes %v", store.prefixes)
	}
	var name, email, phone, ident, body, source string
	if err := admin.QueryRow(ctx, `
		SELECT COALESCE(name,''), COALESCE(email,''), COALESCE(phone_number,''), COALESCE(identifier,'')
		FROM contacts WHERE id=$1`, created.ContactID).
		Scan(&name, &email, &phone, &ident); err != nil {
		t.Fatal(err)
	}
	if name != "" || email != "" || phone != "" || ident != "" {
		t.Fatalf("pii name=%q email=%q phone=%q ident=%q", name, email, phone, ident)
	}
	if err := admin.QueryRow(ctx, `SELECT content FROM messages WHERE conversation_id=$1`, created.ConversationID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if body != "" {
		t.Fatalf("content=%q", body)
	}
	if err := admin.QueryRow(ctx, `SELECT source_id FROM contact_inboxes WHERE id=$1`, created.ContactInboxID).Scan(&source); err != nil {
		t.Fatal(err)
	}
	if source != "purged:"+created.ContactInboxID.String() {
		t.Fatalf("source_id=%s", source)
	}
}
