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

type AccountRow struct {
	ID     uuid.UUID
	Name   string
	Locale string
}

type UserRow struct {
	ID        uuid.UUID
	AccountID uuid.UUID
	Name      string
	Email     string
	Role      string
}

type UpdateUserInput struct {
	ID        uuid.UUID
	AccountID uuid.UUID
	Name      string
	Email     string
	Password  string
	Role      string
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

func (s *Service) ListAccounts(ctx context.Context) ([]AccountRow, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id, name, locale FROM accounts ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AccountRow{}
	for rows.Next() {
		var row AccountRow
		if err := rows.Scan(&row.ID, &row.Name, &row.Locale); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Service) UpdateAccount(ctx context.Context, id uuid.UUID, name, locale string) (AccountRow, error) {
	if id == uuid.Nil {
		return AccountRow{}, ErrNotFound
	}
	name = strings.TrimSpace(name)
	locale = strings.TrimSpace(locale)
	if name == "" && locale == "" {
		return AccountRow{}, ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return AccountRow{}, err
	}
	defer tx.Rollback(ctx)
	var out AccountRow
	err = tx.QueryRow(ctx, `
		UPDATE accounts
		SET name = CASE WHEN $2 = '' THEN name ELSE $2 END,
		    locale = CASE WHEN $3 = '' THEN locale ELSE $3 END,
		    updated_at = CURRENT_TIMESTAMP
		WHERE id = $1
		RETURNING id, name, locale`, id, name, locale,
	).Scan(&out.ID, &out.Name, &out.Locale)
	if err == pgx.ErrNoRows {
		return AccountRow{}, ErrNotFound
	}
	if err != nil {
		return AccountRow{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AccountRow{}, err
	}
	return out, nil
}

func (s *Service) DeleteAccount(ctx context.Context, id uuid.UUID) error {
	if id == uuid.Nil {
		return ErrNotFound
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, id.String()); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM accounts WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (s *Service) ListUsers(ctx context.Context, accountID uuid.UUID) ([]UserRow, error) {
	if accountID == uuid.Nil {
		return nil, ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, accountID.String()); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT u.id, au.account_id, u.name, u.email, au.role
		FROM users u
		JOIN account_users au ON au.user_id = u.id
		WHERE au.account_id = $1
		ORDER BY u.email`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserRow{}
	for rows.Next() {
		var row UserRow
		if err := rows.Scan(&row.ID, &row.AccountID, &row.Name, &row.Email, &row.Role); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Service) UpdateUser(ctx context.Context, in UpdateUserInput) (UserRow, error) {
	if in.ID == uuid.Nil {
		return UserRow{}, ErrNotFound
	}
	name := strings.TrimSpace(in.Name)
	email := strings.ToLower(strings.TrimSpace(in.Email))
	password := in.Password
	role := strings.TrimSpace(in.Role)
	if name == "" && email == "" && password == "" && role == "" {
		return UserRow{}, ErrInvalid
	}
	if role != "" && role != "administrator" && role != "agent" {
		return UserRow{}, ErrInvalid
	}
	if password != "" {
		if err := validateProvisionUser(ProvisionUserInput{Name: "x", Email: "x@x.x", Password: password}); err != nil {
			return UserRow{}, err
		}
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return UserRow{}, err
	}
	defer tx.Rollback(ctx)
	if in.AccountID != uuid.Nil {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
			return UserRow{}, err
		}
	}
	var digest any
	if password != "" {
		hashed, err := HashPassword(password)
		if err != nil {
			return UserRow{}, err
		}
		digest = hashed
	}
	var out UserRow
	err = tx.QueryRow(ctx, `
		UPDATE users
		SET name = CASE WHEN $2 = '' THEN name ELSE $2 END,
		    email = CASE WHEN $3 = '' THEN email ELSE $3 END,
		    password_digest = CASE WHEN $4::text IS NULL THEN password_digest ELSE $4 END,
		    updated_at = CURRENT_TIMESTAMP
		WHERE id = $1
		RETURNING id, name, email`, in.ID, name, email, digest,
	).Scan(&out.ID, &out.Name, &out.Email)
	if err == pgx.ErrNoRows {
		return UserRow{}, ErrNotFound
	}
	if isUniqueViolation(err) {
		return UserRow{}, ErrConflict
	}
	if err != nil {
		return UserRow{}, err
	}
	if role != "" {
		if in.AccountID == uuid.Nil {
			return UserRow{}, ErrInvalid
		}
		tag, err := tx.Exec(ctx, `
			UPDATE account_users SET role = $3 WHERE account_id = $1 AND user_id = $2`,
			in.AccountID, in.ID, role)
		if err != nil {
			return UserRow{}, err
		}
		if tag.RowsAffected() == 0 {
			return UserRow{}, ErrNotFound
		}
		out.AccountID = in.AccountID
		out.Role = role
	} else if in.AccountID != uuid.Nil {
		_ = tx.QueryRow(ctx, `
			SELECT role FROM account_users WHERE account_id = $1 AND user_id = $2`,
			in.AccountID, in.ID).Scan(&out.Role)
		out.AccountID = in.AccountID
	}
	if err := tx.Commit(ctx); err != nil {
		return UserRow{}, err
	}
	return out, nil
}

func (s *Service) DeleteUser(ctx context.Context, userID uuid.UUID) error {
	if userID == uuid.Nil {
		return ErrNotFound
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, userID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	rows, err := tx.Query(ctx, `SELECT id FROM accounts`)
	if err != nil {
		return err
	}
	var accounts []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		accounts = append(accounts, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, accountID := range accounts {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, accountID.String()); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE macros SET created_by = NULL WHERE created_by = $1`, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE csat_survey_responses SET assigned_agent_id = NULL WHERE assigned_agent_id = $1`, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_tool_executions SET approved_by = NULL WHERE approved_by = $1`, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE conversations SET assignee_id = NULL WHERE assignee_id = $1`, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM team_members WHERE user_id = $1`, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM inbox_members WHERE user_id = $1`, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM account_users WHERE user_id = $1`, userID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
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
