package core_test

import (
	"context"
	"testing"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestProvisionAccount_CreatesAdminAndWebInbox(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	svc := &core.Service{DB: app}
	out, err := svc.ProvisionAccount(ctx, core.ProvisionAccountInput{
		Name: "Acme", Locale: "ko",
		User: core.ProvisionUserInput{Name: "Ada", Email: "ada@acme.test", Password: "s3cret-pass"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.AccountID.String() == "" || out.UserID.String() == "" || out.InboxID.String() == "" || out.HMACSecret == "" {
		t.Fatalf("%+v", out)
	}
	var name, locale, role, channel string
	if err := admin.QueryRow(ctx, `SELECT name, locale FROM accounts WHERE id = $1`, out.AccountID).Scan(&name, &locale); err != nil {
		t.Fatal(err)
	}
	if name != "Acme" || locale != "ko" {
		t.Fatalf("account %s %s", name, locale)
	}
	if err := admin.QueryRow(ctx, `SELECT role FROM account_users WHERE account_id = $1 AND user_id = $2`,
		out.AccountID, out.UserID).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != "administrator" {
		t.Fatalf("role %s", role)
	}
	if err := admin.QueryRow(ctx, `SELECT channel_type FROM inboxes WHERE id = $1`, out.InboxID).Scan(&channel); err != nil {
		t.Fatal(err)
	}
	if channel != "web" {
		t.Fatalf("channel %s", channel)
	}
	if _, err := svc.Login(ctx, core.LoginInput{Email: "ada@acme.test", Password: "s3cret-pass"}); err != nil {
		t.Fatal(err)
	}
}

func TestProvisionAccount_RejectsShortPassword(t *testing.T) {
	ctx := context.Background()
	_, app := testutil.Postgres(t)
	svc := &core.Service{DB: app}
	_, err := svc.ProvisionAccount(ctx, core.ProvisionAccountInput{
		Name: "Acme",
		User: core.ProvisionUserInput{Name: "Ada", Email: "ada@acme.test", Password: "short"},
	})
	if err != core.ErrInvalid {
		t.Fatalf("got %v", err)
	}
}

func TestProvisionUser_AddsAgent(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	svc := &core.Service{DB: app}
	acct, err := svc.ProvisionAccount(ctx, core.ProvisionAccountInput{
		Name: "Acme",
		User: core.ProvisionUserInput{Name: "Ada", Email: "ada@acme.test", Password: "s3cret-pass"},
	})
	if err != nil {
		t.Fatal(err)
	}
	out, err := svc.ProvisionUser(ctx, core.ProvisionUserInput{
		AccountID: acct.AccountID, Name: "Bob", Email: "bob@acme.test", Password: "s3cret-pass", Role: "agent",
	})
	if err != nil {
		t.Fatal(err)
	}
	var role string
	if err := admin.QueryRow(ctx, `SELECT role FROM account_users WHERE account_id = $1 AND user_id = $2`,
		acct.AccountID, out.UserID).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != "agent" {
		t.Fatalf("role %s", role)
	}
}
