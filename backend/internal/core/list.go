package core

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ListInput struct {
	ActorUserID    uuid.UUID
	AccountID      uuid.UUID
	InboxIDs       []uuid.UUID
	ConversationID uuid.UUID
}

type ConversationRow struct {
	ID             uuid.UUID
	InboxID        uuid.UUID
	ContactID      uuid.UUID
	ContactInboxID uuid.UUID
	AssigneeID     uuid.UUID
	Status         string
	Version        int
	SnoozedUntil   *time.Time
	DisplayID      int64
	LastContent    string
	Labels         []Label
	SLABreached    bool
	Channel        string
}

type MessageRow struct {
	ID          uuid.UUID
	Content     string
	SenderType  string
	Private     bool
	CreatedAt   time.Time
	Attachments []AttachmentRow
}

type AttachmentRow struct {
	ID          uuid.UUID
	FileType    string
	ExternalURL string
	FileSize    int
}

type ContactRow struct {
	ID         uuid.UUID
	Name       string
	Email      string
	Identifier string
}

func (s *Service) ListConversations(ctx context.Context, in ListInput) ([]ConversationRow, error) {
	var out []ConversationRow
	err := s.withActorAccount(ctx, in, func(tx pgx.Tx, inboxIDs []uuid.UUID) error {
		if len(inboxIDs) == 0 {
			return nil
		}
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
				COALESCE(i.channel_type, '')
			FROM conversations c
			JOIN inboxes i ON i.id = c.inbox_id
			WHERE c.account_id = $1 AND c.inbox_id = ANY($2) AND c.status <> 'resolved'
			ORDER BY c.updated_at DESC`,
			in.AccountID, inboxIDs)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row ConversationRow
			var labels []byte
			if err := rows.Scan(&row.ID, &row.InboxID, &row.ContactID, &row.ContactInboxID, &row.AssigneeID,
				&row.Status, &row.Version, &row.SnoozedUntil, &row.DisplayID, &row.LastContent, &labels, &row.SLABreached, &row.Channel); err != nil {
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

func (s *Service) ListMessages(ctx context.Context, in ListInput) ([]MessageRow, error) {
	if in.ConversationID == uuid.Nil {
		return nil, ErrNotFound
	}
	var out []MessageRow
	err := s.withActorAccount(ctx, in, func(tx pgx.Tx, _ []uuid.UUID) error {
		var inboxID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT inbox_id FROM conversations WHERE id = $1`, in.ConversationID).Scan(&inboxID); err != nil {
			if err == pgx.ErrNoRows {
				return ErrNotFound
			}
			return err
		}
		if err := requireAssignActor(ctx, tx, in.AccountID, inboxID, in.ActorUserID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT id, COALESCE(content, ''), sender_type, private, created_at
			FROM messages WHERE conversation_id = $1
			ORDER BY created_at ASC`, in.ConversationID)
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
		if err := rows.Err(); err != nil {
			return err
		}
		for i := range out {
			atts, err := listMessageAttachments(ctx, tx, out[i].ID)
			if err != nil {
				return err
			}
			out[i].Attachments = atts
		}
		return nil
	})
	if out == nil {
		out = []MessageRow{}
	}
	return out, err
}

func (s *Service) ListContacts(ctx context.Context, in ListInput) ([]ContactRow, error) {
	var out []ContactRow
	err := s.withActorAccount(ctx, in, func(tx pgx.Tx, inboxIDs []uuid.UUID) error {
		if len(inboxIDs) == 0 {
			return nil
		}
		rows, err := tx.Query(ctx, `
			SELECT DISTINCT c.id, COALESCE(c.name, ''), COALESCE(c.email, ''), COALESCE(c.identifier, '')
			FROM contacts c
			JOIN contact_inboxes ci ON ci.contact_id = c.id
			WHERE c.account_id = $1 AND ci.inbox_id = ANY($2) AND c.merged_into_contact_id IS NULL
			ORDER BY c.id`,
			in.AccountID, inboxIDs)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row ContactRow
			if err := rows.Scan(&row.ID, &row.Name, &row.Email, &row.Identifier); err != nil {
				return err
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if out == nil {
		out = []ContactRow{}
	}
	return out, err
}

func listMessageAttachments(ctx context.Context, tx pgx.Tx, messageID uuid.UUID) ([]AttachmentRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, file_type, external_url, COALESCE(file_size, 0)
		FROM attachments WHERE message_id = $1 ORDER BY created_at`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AttachmentRow{}
	for rows.Next() {
		var a AttachmentRow
		if err := rows.Scan(&a.ID, &a.FileType, &a.ExternalURL, &a.FileSize); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Service) withActorAccount(ctx context.Context, in ListInput, fn func(pgx.Tx, []uuid.UUID) error) error {
	if in.ActorUserID == uuid.Nil || in.AccountID == uuid.Nil {
		return ErrDenied
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, in.AccountID.String()); err != nil {
		return err
	}
	var role string
	err = tx.QueryRow(ctx, `
		SELECT role FROM account_users WHERE account_id = $1 AND user_id = $2`,
		in.AccountID, in.ActorUserID,
	).Scan(&role)
	if err != nil {
		if err == pgx.ErrNoRows {
			return ErrDenied
		}
		return err
	}
	inboxIDs := in.InboxIDs
	if role != "administrator" {
		allowed, err := memberInboxIDs(ctx, tx, in.ActorUserID, in.InboxIDs)
		if err != nil {
			return err
		}
		inboxIDs = allowed
	}
	if err := fn(tx, inboxIDs); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func memberInboxIDs(ctx context.Context, tx pgx.Tx, actor uuid.UUID, requested []uuid.UUID) ([]uuid.UUID, error) {
	if len(requested) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT inbox_id FROM inbox_members WHERE user_id = $1 AND inbox_id = ANY($2)`,
		actor, requested)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
