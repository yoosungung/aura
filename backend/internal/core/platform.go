package core

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const minPasswordRunes = 8

type ProvisionUserInput struct {
	AccountID uuid.UUID
	Name      string
	Email     string
	Password  string
	Role      string
}

type ProvisionAccountInput struct {
	Name   string
	Locale string
	User   ProvisionUserInput
}

type ProvisionResult struct {
	AccountID  uuid.UUID
	UserID     uuid.UUID
	InboxID    uuid.UUID
	HMACSecret string
	Role       string
}

func (s *Service) ProvisionAccount(ctx context.Context, in ProvisionAccountInput) (ProvisionResult, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return ProvisionResult{}, ErrInvalid
	}
	locale := strings.TrimSpace(in.Locale)
	if locale == "" {
		locale = "ko"
	}
	in.User.Role = "administrator"
	if err := validateProvisionUser(in.User); err != nil {
		return ProvisionResult{}, err
	}
	accountID, err := uuid.NewV7()
	if err != nil {
		return ProvisionResult{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return ProvisionResult{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO accounts (id, name, locale) VALUES ($1,$2,$3)`,
		accountID, name, locale); err != nil {
		return ProvisionResult{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, accountID.String()); err != nil {
		return ProvisionResult{}, err
	}
	userID, err := insertUser(ctx, tx, in.User)
	if err != nil {
		return ProvisionResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO account_users (account_id, user_id, role) VALUES ($1,$2,'administrator')`,
		accountID, userID); err != nil {
		return ProvisionResult{}, err
	}
	inboxID, secret, err := insertWebInbox(ctx, tx, accountID, name)
	if err != nil {
		return ProvisionResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO inbox_members (account_id, inbox_id, user_id) VALUES ($1,$2,$3)`,
		accountID, inboxID, userID); err != nil {
		return ProvisionResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ProvisionResult{}, err
	}
	return ProvisionResult{
		AccountID: accountID, UserID: userID, InboxID: inboxID, HMACSecret: secret, Role: "administrator",
	}, nil
}

func (s *Service) ProvisionUser(ctx context.Context, in ProvisionUserInput) (ProvisionResult, error) {
	if in.AccountID == uuid.Nil {
		return ProvisionResult{}, ErrInvalid
	}
	if in.Role == "" {
		in.Role = "agent"
	}
	if in.Role != "administrator" && in.Role != "agent" {
		return ProvisionResult{}, ErrInvalid
	}
	if err := validateProvisionUser(in); err != nil {
		return ProvisionResult{}, err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return ProvisionResult{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return ProvisionResult{}, err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM accounts WHERE id = $1)`, in.AccountID).Scan(&exists); err != nil {
		return ProvisionResult{}, err
	}
	if !exists {
		return ProvisionResult{}, ErrNotFound
	}
	userID, err := insertUser(ctx, tx, in)
	if err != nil {
		return ProvisionResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO account_users (account_id, user_id, role) VALUES ($1,$2,$3)`,
		in.AccountID, userID, in.Role); err != nil {
		if isUniqueViolation(err) {
			return ProvisionResult{}, ErrConflict
		}
		return ProvisionResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ProvisionResult{}, err
	}
	return ProvisionResult{AccountID: in.AccountID, UserID: userID, Role: in.Role}, nil
}

func validateProvisionUser(in ProvisionUserInput) error {
	if strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.Email) == "" {
		return ErrInvalid
	}
	if utf8.RuneCountInString(in.Password) < minPasswordRunes {
		return ErrInvalid
	}
	return nil
}

func insertUser(ctx context.Context, tx pgx.Tx, in ProvisionUserInput) (uuid.UUID, error) {
	userID, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, err
	}
	digest, err := HashPassword(in.Password)
	if err != nil {
		return uuid.Nil, err
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (id, email, name, password_digest, pubsub_token)
		VALUES ($1,$2,$3,$4,$5)`,
		userID, email, strings.TrimSpace(in.Name), digest, uuid.NewString()); err != nil {
		if isUniqueViolation(err) {
			return uuid.Nil, ErrConflict
		}
		return uuid.Nil, err
	}
	return userID, nil
}

func insertWebInbox(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, accountName string) (uuid.UUID, string, error) {
	inboxID, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, "", err
	}
	secret, err := randomHex(32)
	if err != nil {
		return uuid.Nil, "", err
	}
	name := strings.TrimSpace(accountName) + " Web"
	if _, err := tx.Exec(ctx, `
		INSERT INTO inboxes (id, account_id, name, channel_type, hmac_secret)
		VALUES ($1,$2,$3,'web',$4)`, inboxID, accountID, name, secret); err != nil {
		return uuid.Nil, "", err
	}
	return inboxID, secret, nil
}
