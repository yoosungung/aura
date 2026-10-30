package core

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/ingest"
)

type PurgeInput struct {
	ActorUserID uuid.UUID
	AccountID   uuid.UUID
	ContactID   uuid.UUID
}

type ArchiveStore interface {
	DeletePrefix(ctx context.Context, prefix string) error
}

func (s *Service) PurgeContact(ctx context.Context, in PurgeInput) error {
	if in.ContactID == uuid.Nil {
		return ErrInvalid
	}
	type conv struct {
		InboxID        uuid.UUID
		ConversationID uuid.UUID
	}
	var convs []conv
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, `
			SELECT inbox_id, id FROM conversations WHERE contact_id = $1`, in.ContactID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c conv
			if err := rows.Scan(&c.InboxID, &c.ConversationID); err != nil {
				return err
			}
			convs = append(convs, c)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE contacts SET
				name = NULL, email = NULL, phone_number = NULL, identifier = NULL,
				custom_attributes = '{}'::jsonb, updated_at = CURRENT_TIMESTAMP
			WHERE id = $1`, in.ContactID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE contact_inboxes SET source_id = 'purged:' || id::text
			WHERE contact_id = $1`, in.ContactID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE messages SET content = '', updated_at = CURRENT_TIMESTAMP
			WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = $1)`, in.ContactID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE ontology_nodes SET name = 'purged', properties = '{}'::jsonb, updated_at = CURRENT_TIMESTAMP
			WHERE entity_type = 'Customer' AND external_ref_id = $1`, in.ContactID.String()); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE csat_survey_responses SET feedback = '', review_note = ''
			WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = $1)`, in.ContactID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE agent_tool_executions SET input_args = '{}'::jsonb, output_result = '{}'::jsonb
			WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = $1)`, in.ContactID); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	if s.JS != nil {
		stream, err := s.JS.Stream(ctx, ingest.ConversationsStream)
		if err == nil {
			for _, c := range convs {
				subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.>", in.AccountID, c.InboxID, c.ConversationID)
				_ = stream.Purge(ctx, jetstream.WithPurgeSubject(subject))
			}
		}
	}
	if s.Archive != nil {
		for _, c := range convs {
			_ = s.Archive.DeletePrefix(ctx, in.AccountID.String()+"/"+c.ConversationID.String()+"/")
		}
	}
	return nil
}

type FilerPurge struct {
	Endpoint string
	Client   *http.Client
}

func (f FilerPurge) DeletePrefix(ctx context.Context, prefix string) error {
	endpoint := strings.TrimRight(f.Endpoint, "/")
	if endpoint == "" || prefix == "" {
		return nil
	}
	client := f.Client
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint+"/archive/"+strings.Trim(prefix, "/")+"/?recursive=true", nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode >= 300 && res.StatusCode != http.StatusNotFound {
		return fmt.Errorf("filer %d", res.StatusCode)
	}
	return nil
}
