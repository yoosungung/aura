package core

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const KakaoSession = 30 * 24 * time.Hour

type KakaoReplyOut struct {
	From        string
	To          string
	Template    string
	Phone       string
	SessionLive bool
}

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

func (s *Service) KakaoReply(ctx context.Context, in ListInput) (KakaoReplyOut, bool, error) {
	if in.ActorUserID == uuid.Nil || in.AccountID == uuid.Nil || in.ConversationID == uuid.Nil {
		return KakaoReplyOut{}, false, ErrDenied
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return KakaoReplyOut{}, false, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return KakaoReplyOut{}, false, err
	}
	var inboxID uuid.UUID
	var channel, from, to, template, phone string
	var lastContact *time.Time
	err = tx.QueryRow(ctx, `
		SELECT c.inbox_id, i.channel_type, COALESCE(i.kakao_sender_key, ''), COALESCE(ci.source_id, ''),
			COALESCE(i.kakao_alimtalk_template, ''), COALESCE(ct.phone_number, ''),
			(SELECT m.created_at FROM messages m
				WHERE m.conversation_id = c.id AND m.sender_type = 'Contact' AND NOT m.private
				ORDER BY m.created_at DESC LIMIT 1)
		FROM conversations c
		JOIN inboxes i ON i.id = c.inbox_id
		JOIN contact_inboxes ci ON ci.id = c.contact_inbox_id
		JOIN contacts ct ON ct.id = c.contact_id
		WHERE c.id = $1`, in.ConversationID,
	).Scan(&inboxID, &channel, &from, &to, &template, &phone, &lastContact)
	if err != nil {
		if err == pgx.ErrNoRows {
			return KakaoReplyOut{}, false, ErrNotFound
		}
		return KakaoReplyOut{}, false, err
	}
	if err := requireAssignActor(ctx, tx, in.AccountID, inboxID, in.ActorUserID); err != nil {
		return KakaoReplyOut{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return KakaoReplyOut{}, false, err
	}
	if channel != "kakao" {
		return KakaoReplyOut{}, true, nil
	}
	if from == "" || to == "" {
		return KakaoReplyOut{}, false, ErrInvalid
	}
	live := lastContact != nil && time.Since(*lastContact) < KakaoSession
	if !live && template == "" {
		return KakaoReplyOut{}, false, ErrInvalid
	}
	return KakaoReplyOut{From: from, To: to, Template: template, Phone: phone, SessionLive: live}, false, nil
}
