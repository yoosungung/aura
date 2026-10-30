package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

func (s *Service) SubmitCSAT(ctx context.Context, tok Token, inboxID uuid.UUID, rating int, feedback string) error {
	if tok.Kind != KindContact || tok.InboxID != inboxID || tok.ConversationID == uuid.Nil {
		return ErrForbidden
	}
	if rating < 1 || rating > 5 {
		return ErrInvalid
	}
	if s.Bus == nil {
		return ErrInvalid
	}
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	env, err := json.Marshal(map[string]any{
		"id":              id.String(),
		"schema_version":  1,
		"type":            "csat_submitted",
		"occurred_at":     time.Now().UTC().Format(time.RFC3339Nano),
		"account_id":      tok.AccountID.String(),
		"inbox_id":        inboxID.String(),
		"conversation_id": tok.ConversationID.String(),
		"trace_id":        newTraceID(),
		"hop_count":       0,
		"payload": map[string]any{
			"rating":   rating,
			"feedback": feedback,
		},
	})
	if err != nil {
		return err
	}
	subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.csat_submitted", tok.AccountID, inboxID, tok.ConversationID)
	return s.Bus.PublishEvent(ctx, subject, env)
}
