package core

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type IdentifyInput struct {
	AccountID      uuid.UUID
	InboxID        uuid.UUID
	ContactID      uuid.UUID
	Identifier     string
	IdentifierHash string
	Name           string
	Email          string
}

type IdentifyResult struct {
	ContactID  uuid.UUID
	Identifier string
	Name       string
	Email      string
}

func IdentifierHash(secret, identifier string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(identifier))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Service) IdentifyContact(ctx context.Context, in IdentifyInput) (IdentifyResult, error) {
	if in.AccountID == uuid.Nil || in.InboxID == uuid.Nil || in.ContactID == uuid.Nil || in.Identifier == "" || in.IdentifierHash == "" {
		return IdentifyResult{}, ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return IdentifyResult{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return IdentifyResult{}, err
	}
	var secret string
	var inboxAccount uuid.UUID
	err = tx.QueryRow(ctx, `SELECT hmac_secret, account_id FROM inboxes WHERE id = $1`, in.InboxID).Scan(&secret, &inboxAccount)
	if err != nil {
		if err == pgx.ErrNoRows {
			return IdentifyResult{}, ErrNotFound
		}
		return IdentifyResult{}, err
	}
	if inboxAccount != in.AccountID {
		return IdentifyResult{}, ErrDenied
	}
	want := IdentifierHash(secret, in.Identifier)
	if subtle.ConstantTimeCompare([]byte(want), []byte(in.IdentifierHash)) != 1 {
		return IdentifyResult{}, ErrUnauthorized
	}
	var taken bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM contacts WHERE account_id = $1 AND identifier = $2 AND id <> $3)`,
		in.AccountID, in.Identifier, in.ContactID,
	).Scan(&taken); err != nil {
		return IdentifyResult{}, err
	}
	if taken {
		return IdentifyResult{}, ErrConflict
	}
	var out IdentifyResult
	err = tx.QueryRow(ctx, `
		UPDATE contacts
		SET identifier = $1,
			name = CASE WHEN $2 = '' THEN name ELSE $2 END,
			email = CASE WHEN $3 = '' THEN email ELSE $3 END,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = $4
		RETURNING id, COALESCE(identifier, ''), COALESCE(name, ''), COALESCE(email, '')`,
		in.Identifier, in.Name, in.Email, in.ContactID,
	).Scan(&out.ContactID, &out.Identifier, &out.Name, &out.Email)
	if err != nil {
		if err == pgx.ErrNoRows {
			return IdentifyResult{}, ErrNotFound
		}
		return IdentifyResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return IdentifyResult{}, err
	}
	return out, nil
}
