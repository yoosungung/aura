package core_test

import (
	"context"
	"testing"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestUpsertMCP_AdminOnlyAndRotate(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, _ := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss-mcp@acme.test", "administrator", "s3cret")
	agentID := seedUser(t, admin, accountID, "ada-mcp@acme.test", "agent", "s3cret")
	svc := &core.Service{DB: app}

	got, err := svc.UpsertMCP(ctx, core.MCPInput{
		ActorUserID: adminID, AccountID: accountID,
		Name: "shop", URL: "https://ops.example/mcp", AuthHeader: "Bearer tok",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.URL != "https://ops.example/mcp" || got.AuthHeader != "Bearer tok" {
		t.Fatalf("%+v", got)
	}
	_, err = svc.UpsertMCP(ctx, core.MCPInput{
		ActorUserID: agentID, AccountID: accountID, Name: "other", URL: "https://ops.example/x",
	})
	if err != core.ErrDenied {
		t.Fatalf("agent got %v", err)
	}

	rotated, err := svc.RotateMCP(ctx, core.MCPInput{
		ActorUserID: adminID, AccountID: accountID, ServerID: got.ID, AuthHeader: "Bearer new",
	})
	if err != nil {
		t.Fatal(err)
	}
	if rotated.AuthHeader != "Bearer new" {
		t.Fatalf("%+v", rotated)
	}

	list, err := svc.ListMCP(ctx, core.MCPInput{ActorUserID: adminID, AccountID: accountID})
	if err != nil || len(list) != 1 {
		t.Fatalf("list %v %+v", err, list)
	}
}

func TestUpsertAgentSkill_OverridesName(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	accountID, _ := seedInbox(t, admin)
	adminID := seedUser(t, admin, accountID, "boss-skill@acme.test", "administrator", "s3cret")
	svc := &core.Service{DB: app}

	first, err := svc.UpsertAgentSkill(ctx, core.AgentSkillInput{
		ActorUserID: adminID, AccountID: accountID,
		Name: "refund-policy", Description: "a", Body: "FIRST",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.UpsertAgentSkill(ctx, core.AgentSkillInput{
		ActorUserID: adminID, AccountID: accountID,
		Name: "refund-policy", Description: "b", Body: "SECOND",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID || second.Body != "SECOND" {
		t.Fatalf("%+v %+v", first, second)
	}
}
