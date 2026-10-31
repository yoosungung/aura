package core

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

type PresenceInput struct {
	UserID    uuid.UUID
	AccountID uuid.UUID
	Status    string
}

func (s *Service) SetPresence(ctx context.Context, in PresenceInput) error {
	if in.UserID == uuid.Nil || in.AccountID == uuid.Nil || (in.Status != "online" && in.Status != "offline") {
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
	var n int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM account_users WHERE account_id = $1 AND user_id = $2`,
		in.AccountID, in.UserID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrDenied
	}
	if _, err := tx.Exec(ctx, `
		UPDATE users SET availability_status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
		in.UserID, in.Status); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.publishPresence(in)
	return nil
}

func (s *Service) publishPresence(in PresenceInput) {
	if s.NC == nil {
		return
	}
	body, err := json.Marshal(map[string]any{
		"type": "event", "event": "presence",
		"account_id": in.AccountID.String(),
		"user_id":    in.UserID.String(),
		"status":     in.Status,
	})
	if err != nil {
		return
	}
	_ = s.NC.Publish(fmt.Sprintf("helpdesk.realtime.%s.agent.presence", in.AccountID), body)
}
