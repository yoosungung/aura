package core

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const SessionTTL = 7 * 24 * time.Hour

type LoginInput struct {
	Email    string
	Password string
}

type AuthAccount struct {
	AccountID uuid.UUID
	Role      string
	InboxIDs  []uuid.UUID
}

type AuthResult struct {
	UserID       uuid.UUID
	Email        string
	Name         string
	SessionID    uuid.UUID
	SessionToken string
	Accounts     []AuthAccount
}

func (s *Service) Login(ctx context.Context, in LoginInput) (AuthResult, error) {
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if email == "" || in.Password == "" {
		return AuthResult{}, ErrUnauthorized
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return AuthResult{}, err
	}
	defer tx.Rollback(ctx)

	var userID uuid.UUID
	var name, digest string
	err = tx.QueryRow(ctx, `
		SELECT id, email, name, password_digest FROM users WHERE lower(email) = $1`, email,
	).Scan(&userID, &email, &name, &digest)
	if err != nil {
		_ = CheckPassword(dummyDigest(), in.Password)
		if err == pgx.ErrNoRows {
			return AuthResult{}, ErrUnauthorized
		}
		return AuthResult{}, err
	}
	if !CheckPassword(digest, in.Password) {
		return AuthResult{}, ErrUnauthorized
	}
	out, err := s.issueSession(ctx, tx, userID, email, name)
	if err != nil {
		return AuthResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AuthResult{}, err
	}
	return out, nil
}

func (s *Service) Refresh(ctx context.Context, sessionToken string) (AuthResult, error) {
	digest := sessionDigest(sessionToken)
	if digest == "" {
		return AuthResult{}, ErrUnauthorized
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return AuthResult{}, err
	}
	defer tx.Rollback(ctx)

	var userID, sessionID uuid.UUID
	var email, name string
	var expires time.Time
	err = tx.QueryRow(ctx, `
		SELECT s.id, s.user_id, s.expires_at, u.email, u.name
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_digest = $1`, digest,
	).Scan(&sessionID, &userID, &expires, &email, &name)
	if err != nil {
		if err == pgx.ErrNoRows {
			return AuthResult{}, ErrUnauthorized
		}
		return AuthResult{}, err
	}
	if !expires.After(time.Now().UTC()) {
		return AuthResult{}, ErrUnauthorized
	}
	accounts, err := loadMembership(ctx, tx, userID)
	if err != nil {
		return AuthResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AuthResult{}, err
	}
	return AuthResult{
		UserID: userID, Email: email, Name: name,
		SessionID: sessionID, SessionToken: sessionToken, Accounts: accounts,
	}, nil
}

type ContactAuthInput struct {
	InboxID     uuid.UUID
	PubsubToken string
}

type ContactAuthResult struct {
	AccountID      uuid.UUID
	InboxID        uuid.UUID
	ContactID      uuid.UUID
	ContactInboxID uuid.UUID
	ConversationID uuid.UUID
	SourceID       string
}

func (s *Service) AuthContact(ctx context.Context, in ContactAuthInput) (ContactAuthResult, error) {
	if in.InboxID == uuid.Nil || strings.TrimSpace(in.PubsubToken) == "" {
		return ContactAuthResult{}, ErrUnauthorized
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return ContactAuthResult{}, err
	}
	defer tx.Rollback(ctx)
	var out ContactAuthResult
	var convID *uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT account_id, inbox_id, contact_id, contact_inbox_id, source_id, conversation_id
		FROM auth_contact_seed($1, $2)`, in.InboxID, in.PubsubToken,
	).Scan(&out.AccountID, &out.InboxID, &out.ContactID, &out.ContactInboxID, &out.SourceID, &convID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return ContactAuthResult{}, ErrUnauthorized
		}
		return ContactAuthResult{}, err
	}
	if convID != nil {
		out.ConversationID = *convID
	}
	if err := tx.Commit(ctx); err != nil {
		return ContactAuthResult{}, err
	}
	return out, nil
}

func (s *Service) Logout(ctx context.Context, sessionToken string) error {
	digest := sessionDigest(sessionToken)
	if digest == "" {
		return nil
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE token_digest = $1`, digest); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) issueSession(ctx context.Context, tx pgx.Tx, userID uuid.UUID, email, name string) (AuthResult, error) {
	sessionID, err := uuid.NewV7()
	if err != nil {
		return AuthResult{}, err
	}
	raw, digest, err := newSessionToken()
	if err != nil {
		return AuthResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sessions (id, user_id, token_digest, expires_at)
		VALUES ($1,$2,$3,$4)`, sessionID, userID, digest, time.Now().UTC().Add(SessionTTL)); err != nil {
		return AuthResult{}, err
	}
	accounts, err := loadMembership(ctx, tx, userID)
	if err != nil {
		return AuthResult{}, err
	}
	if len(accounts) == 0 {
		return AuthResult{}, ErrUnauthorized
	}
	return AuthResult{
		UserID: userID, Email: email, Name: name,
		SessionID: sessionID, SessionToken: raw, Accounts: accounts,
	}, nil
}

func loadMembership(ctx context.Context, tx pgx.Tx, userID uuid.UUID) ([]AuthAccount, error) {
	rows, err := tx.Query(ctx, `SELECT account_id, role, inbox_id FROM auth_login_membership($1)`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byAccount := map[uuid.UUID]*AuthAccount{}
	var order []uuid.UUID
	for rows.Next() {
		var accountID uuid.UUID
		var role string
		var inboxID *uuid.UUID
		if err := rows.Scan(&accountID, &role, &inboxID); err != nil {
			return nil, err
		}
		acc, ok := byAccount[accountID]
		if !ok {
			acc = &AuthAccount{AccountID: accountID, Role: role}
			byAccount[accountID] = acc
			order = append(order, accountID)
		}
		if inboxID != nil {
			acc.InboxIDs = append(acc.InboxIDs, *inboxID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]AuthAccount, 0, len(order))
	for _, id := range order {
		out = append(out, *byAccount[id])
	}
	return out, nil
}

func newSessionToken() (raw, digest string, err error) {
	buf := make([]byte, 32)
	if _, err = rand.Read(buf); err != nil {
		return "", "", err
	}
	raw = hex.EncodeToString(buf)
	return raw, sessionDigest(raw), nil
}

func sessionDigest(raw string) string {
	if raw == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
