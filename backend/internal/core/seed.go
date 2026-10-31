package core

import (
	"context"

	"github.com/jackc/pgx/v5"
)

const (
	DevSeedEmail    = "admin@example.com"
	DevSeedPassword = "admin1234"
	DevSeedName     = "Admin"
	DevSeedAccount  = "Local"
)

// SeedDevLogin creates the local compose administrator once. Superuser DSN.
func SeedDevLogin(ctx context.Context, db DB) (ProvisionResult, bool, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return ProvisionResult{}, false, err
	}
	defer tx.Rollback(ctx)

	var existing ProvisionResult
	err = tx.QueryRow(ctx, `
		SELECT u.id, au.account_id, au.role
		FROM users u
		JOIN account_users au ON au.user_id = u.id
		WHERE lower(u.email) = $1
		LIMIT 1`, DevSeedEmail,
	).Scan(&existing.UserID, &existing.AccountID, &existing.Role)
	if err == nil {
		return existing, true, tx.Commit(ctx)
	}
	if err != pgx.ErrNoRows {
		return ProvisionResult{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ProvisionResult{}, false, err
	}

	svc := &Service{DB: db}
	out, err := svc.ProvisionAccount(ctx, ProvisionAccountInput{
		Name:   DevSeedAccount,
		Locale: "ko",
		User: ProvisionUserInput{
			Name:     DevSeedName,
			Email:    DevSeedEmail,
			Password: DevSeedPassword,
		},
	})
	return out, false, err
}
