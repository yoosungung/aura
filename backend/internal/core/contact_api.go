package core

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ContactScope struct {
	AccountID      uuid.UUID
	InboxID        uuid.UUID
	ContactID      uuid.UUID
	ConversationID uuid.UUID
}

func (s *Service) ListContactConversations(ctx context.Context, in ContactScope) ([]ConversationRow, error) {
	if in.AccountID == uuid.Nil || in.InboxID == uuid.Nil || in.ContactID == uuid.Nil {
		return nil, ErrInvalid
	}
	var out []ConversationRow
	err := s.withContactScope(ctx, in, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT c.id, c.inbox_id, c.contact_id, c.contact_inbox_id, COALESCE(c.assignee_id, '00000000-0000-0000-0000-000000000000'),
				c.status, c.version, c.snoozed_until, c.display_id,
				COALESCE((SELECT m.content FROM messages m
					WHERE m.conversation_id = c.id AND NOT m.private
					ORDER BY m.created_at DESC LIMIT 1), ''),
				COALESCE((SELECT json_agg(json_build_object('id', l.id::text, 'name', l.name, 'color', COALESCE(l.color, '')) ORDER BY l.name)
					FROM conversation_labels cl JOIN labels l ON l.id = cl.label_id
					WHERE cl.conversation_id = c.id), '[]'::json),
				EXISTS (
					SELECT 1 FROM applied_slas a
					WHERE a.conversation_id = c.id
						AND (a.is_frt_breached OR a.is_nrt_breached OR a.is_rt_breached)
				),
				COALESCE(i.channel_type, ''),
				COALESCE(ct.name, ''), COALESCE(ct.email, ''),
				COALESCE((SELECT m.created_at FROM messages m
					WHERE m.conversation_id = c.id AND NOT m.private
					ORDER BY m.created_at DESC LIMIT 1), c.updated_at),
				sla.frt_due_at, sla.nrt_due_at, sla.rt_due_at
			FROM conversations c
			JOIN inboxes i ON i.id = c.inbox_id
			JOIN contacts ct ON ct.id = c.contact_id
			LEFT JOIN LATERAL (
				SELECT frt_due_at, nrt_due_at, rt_due_at
				FROM applied_slas a WHERE a.conversation_id = c.id LIMIT 1
			) sla ON true
			WHERE c.account_id = $1 AND c.inbox_id = $2 AND c.contact_id = $3
			ORDER BY c.updated_at DESC`,
			in.AccountID, in.InboxID, in.ContactID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row ConversationRow
			var labels []byte
			if err := rows.Scan(&row.ID, &row.InboxID, &row.ContactID, &row.ContactInboxID, &row.AssigneeID,
				&row.Status, &row.Version, &row.SnoozedUntil, &row.DisplayID, &row.LastContent, &labels, &row.SLABreached, &row.Channel,
				&row.ContactName, &row.ContactEmail, &row.LastActivityAt, &row.FRTDueAt, &row.NRTDueAt, &row.RTDueAt); err != nil {
				return err
			}
			if err := json.Unmarshal(labels, &row.Labels); err != nil {
				return err
			}
			if row.Labels == nil {
				row.Labels = []Label{}
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if out == nil {
		out = []ConversationRow{}
	}
	return out, err
}

func (s *Service) ListContactMessages(ctx context.Context, in ContactScope) ([]MessageRow, error) {
	if in.ConversationID == uuid.Nil {
		return nil, ErrNotFound
	}
	var out []MessageRow
	err := s.withContactScope(ctx, in, func(tx pgx.Tx) error {
		var contactID, inboxID uuid.UUID
		err := tx.QueryRow(ctx, `SELECT contact_id, inbox_id FROM conversations WHERE id = $1`, in.ConversationID).
			Scan(&contactID, &inboxID)
		if err != nil {
			if err == pgx.ErrNoRows {
				return ErrNotFound
			}
			return err
		}
		if contactID != in.ContactID || inboxID != in.InboxID {
			return ErrDenied
		}
		rows, err := tx.Query(ctx, `
			SELECT m.id, COALESCE(m.content, ''), m.sender_type, m.private, m.created_at
			FROM messages m
			WHERE m.conversation_id = $1 AND NOT m.private
			ORDER BY m.created_at ASC`, in.ConversationID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row MessageRow
			if err := rows.Scan(&row.ID, &row.Content, &row.SenderType, &row.Private, &row.CreatedAt); err != nil {
				return err
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if out == nil {
		out = []MessageRow{}
	}
	return out, err
}

func (s *Service) withContactScope(ctx context.Context, in ContactScope, fn func(pgx.Tx) error) error {
	if in.AccountID == uuid.Nil || in.InboxID == uuid.Nil || in.ContactID == uuid.Nil {
		return ErrInvalid
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return err
	}
	var ok bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM contact_inboxes WHERE contact_id = $1 AND inbox_id = $2)`,
		in.ContactID, in.InboxID).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return ErrDenied
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
