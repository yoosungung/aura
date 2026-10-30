package core_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func mustV7(t *testing.T) uuid.UUID {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestReport_CSATPercentAndSLAHitRate(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, inboxID := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}
	a, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "a", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := svc.Create(ctx, core.CreateInput{AccountID: accountID, InboxID: inboxID, SourceID: "b", TraceID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Transition(ctx, core.TransitionInput{
		AccountID: accountID, ConversationID: a.ConversationID,
		NewStatus: core.StatusResolved, ExpectedVersion: 1, TraceID: "t",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO csat_survey_responses (id, account_id, conversation_id, assigned_agent_id, rating)
		VALUES ($1,$2,$3,$4,5), ($5,$2,$6,$4,2)`,
		mustV7(t), accountID, a.ConversationID, agentID, mustV7(t), b.ConversationID); err != nil {
		t.Fatal(err)
	}
	policyID := mustV7(t)
	if _, err := admin.Exec(ctx, `
		INSERT INTO sla_policies (id, account_id, name, frt_threshold_seconds)
		VALUES ($1,$2,'std',60)`, policyID, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		INSERT INTO applied_slas (id, account_id, conversation_id, sla_policy_id, is_frt_breached, is_nrt_breached, is_rt_breached)
		VALUES ($1,$2,$3,$4,false,false,false), ($5,$2,$6,$4,true,false,false)`,
		mustV7(t), accountID, a.ConversationID, policyID, mustV7(t), b.ConversationID); err != nil {
		t.Fatal(err)
	}
	rep, err := svc.Report(ctx, core.ReportInput{ActorUserID: adminID, AccountID: accountID})
	if err != nil {
		t.Fatal(err)
	}
	if rep.CSATPercent != 50 {
		t.Fatalf("csat %v", rep.CSATPercent)
	}
	if rep.SLAHitRate != 50 {
		t.Fatalf("sla %v", rep.SLAHitRate)
	}
	if rep.Conversations.Total != 2 || rep.Conversations.Resolved != 1 {
		t.Fatalf("conversations %+v", rep.Conversations)
	}
	if len(rep.Inboxes) != 1 || rep.Inboxes[0].ConversationCount != 2 {
		t.Fatalf("inboxes %+v", rep.Inboxes)
	}
	_, err = svc.Report(ctx, core.ReportInput{ActorUserID: agentID, AccountID: accountID})
	if err != core.ErrDenied {
		t.Fatalf("agent got %v", err)
	}
}

func TestReport_EmptyIsZero(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, _ := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}
	rep, err := svc.Report(ctx, core.ReportInput{ActorUserID: adminID, AccountID: accountID})
	if err != nil {
		t.Fatal(err)
	}
	if rep.CSATPercent != 0 || rep.SLAHitRate != 0 {
		t.Fatalf("%+v", rep)
	}
}
