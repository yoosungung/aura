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

func TestListAccounts_ReturnsProvisioned(t *testing.T) {
	ctx := context.Background()
	_, app := testutil.Postgres(t)
	svc := &core.Service{DB: app}
	acct, err := svc.ProvisionAccount(ctx, core.ProvisionAccountInput{
		Name: "Acme", Locale: "ko",
		User: core.ProvisionUserInput{Name: "Ada", Email: "ada@acme.test", Password: "s3cret-pass"},
	})
	if err != nil {
		t.Fatal(err)
	}
	list, err := svc.ListAccounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range list {
		if row.ID == acct.AccountID && row.Name == "Acme" && row.Locale == "ko" {
			found = true
		}
	}
	if !found {
		t.Fatalf("%+v", list)
	}
}

func TestUpdateAccount_Renames(t *testing.T) {
	ctx := context.Background()
	_, app := testutil.Postgres(t)
	svc := &core.Service{DB: app}
	acct, err := svc.ProvisionAccount(ctx, core.ProvisionAccountInput{
		Name: "Acme", Locale: "ko",
		User: core.ProvisionUserInput{Name: "Ada", Email: "ada@acme.test", Password: "s3cret-pass"},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := svc.UpdateAccount(ctx, acct.AccountID, "Renamed", "en")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Renamed" || got.Locale != "en" {
		t.Fatalf("%+v", got)
	}
}

func TestDeleteAccount_RemovesRow(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	svc := &core.Service{DB: app}
	acct, err := svc.ProvisionAccount(ctx, core.ProvisionAccountInput{
		Name: "Acme", Locale: "ko",
		User: core.ProvisionUserInput{Name: "Ada", Email: "ada@acme.test", Password: "s3cret-pass"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteAccount(ctx, acct.AccountID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM accounts WHERE id = $1`, acct.AccountID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("count %d", n)
	}
}

func TestListUsers_ByAccount(t *testing.T) {
	ctx := context.Background()
	_, app := testutil.Postgres(t)
	svc := &core.Service{DB: app}
	acct, err := svc.ProvisionAccount(ctx, core.ProvisionAccountInput{
		Name: "Acme",
		User: core.ProvisionUserInput{Name: "Ada", Email: "ada@acme.test", Password: "s3cret-pass"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ProvisionUser(ctx, core.ProvisionUserInput{
		AccountID: acct.AccountID, Name: "Bob", Email: "bob@acme.test", Password: "s3cret-pass", Role: "agent",
	}); err != nil {
		t.Fatal(err)
	}
	list, err := svc.ListUsers(ctx, acct.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("%+v", list)
	}
}

func TestUpdateUser_Name(t *testing.T) {
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
	got, err := svc.UpdateUser(ctx, core.UpdateUserInput{ID: acct.UserID, Name: "Ada Lovelace"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Ada Lovelace" {
		t.Fatalf("%+v", got)
	}
	var name string
	if err := admin.QueryRow(ctx, `SELECT name FROM users WHERE id = $1`, acct.UserID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "Ada Lovelace" {
		t.Fatalf("name %s", name)
	}
}

func TestDeleteUser_RemovesRow(t *testing.T) {
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
	bob, err := svc.ProvisionUser(ctx, core.ProvisionUserInput{
		AccountID: acct.AccountID, Name: "Bob", Email: "bob@acme.test", Password: "s3cret-pass", Role: "agent",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteUser(ctx, bob.UserID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = $1`, bob.UserID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("count %d", n)
	}
}
