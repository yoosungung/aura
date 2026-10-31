package core_test

import (
	"context"
	"testing"

	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestSeedDevLogin_CreatesAdminAndIsIdempotent(t *testing.T) {
	ctx := context.Background()
	admin, app := testutil.Postgres(t)
	svc := &core.Service{DB: app}

	first, skipped, err := core.SeedDevLogin(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	if skipped || first.UserID.String() == "" || first.AccountID.String() == "" || first.InboxID.String() == "" {
		t.Fatalf("first %+v skipped=%v", first, skipped)
	}
	if first.Role != "administrator" {
		t.Fatalf("role %s", first.Role)
	}

	if _, err := svc.Login(ctx, core.LoginInput{Email: core.DevSeedEmail, Password: core.DevSeedPassword}); err != nil {
		t.Fatal(err)
	}

	second, skipped, err := core.SeedDevLogin(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	if !skipped {
		t.Fatal("expected skip on second seed")
	}
	if second.UserID != first.UserID || second.AccountID != first.AccountID {
		t.Fatalf("second %+v first %+v", second, first)
	}

	var n int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM users WHERE lower(email) = $1`, core.DevSeedEmail).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("users=%d", n)
	}
}
