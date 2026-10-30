package core

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type KakaoInput struct {
	AccountID uuid.UUID
	InboxID   uuid.UUID
	MsgKey    string
	UserKey   string
}

func (s *Service) ResolveKakaoInbox(ctx context.Context, senderKey string) (uuid.UUID, uuid.UUID, error) {
	if senderKey == "" {
		return uuid.Nil, uuid.Nil, ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	defer tx.Rollback(ctx)

	var accountID, inboxID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT account_id, inbox_id FROM inbox_by_kakao($1)`, senderKey).Scan(&accountID, &inboxID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return uuid.Nil, uuid.Nil, ErrNotFound
		}
		return uuid.Nil, uuid.Nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	return accountID, inboxID, nil
}

func (s *Service) ResolveKakao(ctx context.Context, in KakaoInput) (CreateResult, bool, bool, error) {
	if in.AccountID == uuid.Nil || in.InboxID == uuid.Nil || in.MsgKey == "" || in.UserKey == "" {
		return CreateResult{}, false, false, ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return CreateResult{}, false, false, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return CreateResult{}, false, false, err
	}

	load := func(convID uuid.UUID) (CreateResult, error) {
		var out CreateResult
		err := tx.QueryRow(ctx, `
			SELECT id, contact_id, contact_inbox_id, display_id, status, version
			FROM conversations WHERE id = $1`, convID,
		).Scan(&out.ConversationID, &out.ContactID, &out.ContactInboxID, &out.DisplayID, &out.Status, &out.Version)
		return out, err
	}

	var convID uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT conversation_id FROM messages WHERE inbox_id = $1 AND source_id = $2`,
		in.InboxID, in.MsgKey,
	).Scan(&convID)
	if err == nil {
		out, err := load(convID)
		if err != nil {
			return CreateResult{}, false, false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return CreateResult{}, false, false, err
		}
		return out, true, true, nil
	} else if err != pgx.ErrNoRows {
		return CreateResult{}, false, false, err
	}

	err = tx.QueryRow(ctx, `
		SELECT c.id FROM conversations c
		JOIN contact_inboxes ci ON ci.id = c.contact_inbox_id
		WHERE c.inbox_id = $1 AND ci.source_id = $2 AND c.status <> 'resolved'
		ORDER BY c.created_at DESC LIMIT 1`,
		in.InboxID, in.UserKey,
	).Scan(&convID)
	if err == nil {
		out, err := load(convID)
		if err != nil {
			return CreateResult{}, false, false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return CreateResult{}, false, false, err
		}
		return out, true, false, nil
	} else if err != pgx.ErrNoRows {
		return CreateResult{}, false, false, err
	}

	if err := tx.Commit(ctx); err != nil {
		return CreateResult{}, false, false, err
	}
	return CreateResult{}, false, false, nil
}
