package core

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

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

type outboxRow struct {
	ID      uuid.UUID
	Subject string
	Env     []byte
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

	var srcIdent string
	var mergedInto uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(identifier, ''), COALESCE(merged_into_contact_id, '00000000-0000-0000-0000-000000000000'::uuid)
		FROM contacts WHERE id = $1`, in.ContactID,
	).Scan(&srcIdent, &mergedInto)
	if err != nil {
		if err == pgx.ErrNoRows {
			return IdentifyResult{}, ErrNotFound
		}
		return IdentifyResult{}, err
	}
	if mergedInto != uuid.Nil {
		out, err := loadContact(ctx, tx, mergedInto)
		if err != nil {
			return IdentifyResult{}, err
		}
		if out.Identifier != in.Identifier {
			return IdentifyResult{}, ErrConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return IdentifyResult{}, err
		}
		return out, nil
	}

	var target IdentifyResult
	err = tx.QueryRow(ctx, `
		SELECT id, COALESCE(identifier, ''), COALESCE(name, ''), COALESCE(email, '')
		FROM contacts WHERE account_id = $1 AND identifier = $2 AND id <> $3`,
		in.AccountID, in.Identifier, in.ContactID,
	).Scan(&target.ContactID, &target.Identifier, &target.Name, &target.Email)
	if err != nil && err != pgx.ErrNoRows {
		return IdentifyResult{}, err
	}
	if err == nil {
		if srcIdent != "" {
			return IdentifyResult{}, ErrConflict
		}
		events, err := mergeAnonymous(ctx, tx, in, target)
		if err != nil {
			return IdentifyResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return IdentifyResult{}, err
		}
		for _, ev := range events {
			s.publishOutbox(ctx, in.AccountID, ev.ID, ev.Subject, ev.Env)
		}
		return target, nil
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

func loadContact(ctx context.Context, tx pgx.Tx, id uuid.UUID) (IdentifyResult, error) {
	var out IdentifyResult
	err := tx.QueryRow(ctx, `
		SELECT id, COALESCE(identifier, ''), COALESCE(name, ''), COALESCE(email, '')
		FROM contacts WHERE id = $1`, id,
	).Scan(&out.ContactID, &out.Identifier, &out.Name, &out.Email)
	if err == pgx.ErrNoRows {
		return IdentifyResult{}, ErrNotFound
	}
	return out, err
}

func mergeAnonymous(ctx context.Context, tx pgx.Tx, in IdentifyInput, target IdentifyResult) ([]outboxRow, error) {
	if _, err := tx.Exec(ctx, `
		UPDATE contacts SET merged_into_contact_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
		target.ContactID, in.ContactID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id, inbox_id FROM conversations WHERE contact_id = $1`, in.ContactID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type ticket struct{ ID, InboxID uuid.UUID }
	var tickets []ticket
	for rows.Next() {
		var t ticket
		if err := rows.Scan(&t.ID, &t.InboxID); err != nil {
			return nil, err
		}
		tickets = append(tickets, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conversations SET contact_id = $1, updated_at = CURRENT_TIMESTAMP WHERE contact_id = $2`,
		target.ContactID, in.ContactID); err != nil {
		return nil, err
	}
	occurred := time.Now().UTC()
	events := make([]outboxRow, 0, len(tickets))
	for _, t := range tickets {
		eventID, err := uuid.NewV7()
		if err != nil {
			return nil, err
		}
		payload, err := json.Marshal(map[string]any{
			"source_contact_id": in.ContactID.String(),
			"target_contact_id": target.ContactID.String(),
		})
		if err != nil {
			return nil, err
		}
		env, err := json.Marshal(map[string]any{
			"id":              eventID.String(),
			"schema_version":  1,
			"type":            "contact_merged",
			"occurred_at":     occurred.Format(time.RFC3339Nano),
			"account_id":      in.AccountID.String(),
			"inbox_id":        t.InboxID.String(),
			"conversation_id": t.ID.String(),
			"trace_id":        eventID.String(),
			"hop_count":       0,
			"payload":         json.RawMessage(payload),
		})
		if err != nil {
			return nil, err
		}
		subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.contact_merged", in.AccountID, t.InboxID, t.ID)
		if _, err := tx.Exec(ctx, `
			INSERT INTO event_outbox (id, account_id, subject, payload) VALUES ($1,$2,$3,$4::jsonb)`,
			eventID, in.AccountID, subject, string(env)); err != nil {
			return nil, err
		}
		events = append(events, outboxRow{ID: eventID, Subject: subject, Env: env})
	}
	return events, nil
}
