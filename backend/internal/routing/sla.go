package routing

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/core"
)

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

func (s *Service) OnMessage(ctx context.Context, accountID, conversationID uuid.UUID, messageType int, private bool) error {
	if accountID == uuid.Nil || conversationID == uuid.Nil || private {
		return nil
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, accountID.String()); err != nil {
		return err
	}
	if err := applySLA(ctx, tx, accountID, conversationID, s.now()); err != nil {
		return err
	}
	switch messageType {
	case 1:
		if _, err := tx.Exec(ctx, `
			UPDATE conversations SET first_reply_created_at = COALESCE(first_reply_created_at, $2)
			WHERE id = $1`, conversationID, s.now()); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE applied_slas SET nrt_due_at = NULL WHERE conversation_id = $1`, conversationID); err != nil {
			return err
		}
	case 0:
		var nrt *int
		var status string
		var firstReply *time.Time
		err := tx.QueryRow(ctx, `
			SELECT p.nrt_threshold_seconds, c.status, c.first_reply_created_at
			FROM conversations c
			LEFT JOIN applied_slas a ON a.conversation_id = c.id
			LEFT JOIN sla_policies p ON p.id = a.sla_policy_id
			WHERE c.id = $1`, conversationID,
		).Scan(&nrt, &status, &firstReply)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		if nrt != nil && firstReply != nil && status != core.StatusPending {
			due := slaDue(ctx, tx, conversationID, s.now(), *nrt)
			if _, err := tx.Exec(ctx, `UPDATE applied_slas SET nrt_due_at = $2 WHERE conversation_id = $1`, conversationID, due); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

func (s *Service) Evaluate(ctx context.Context, accountID, conversationID uuid.UUID) error {
	if accountID == uuid.Nil || conversationID == uuid.Nil {
		return nil
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.current_account_id', $1, true)`, accountID.String()); err != nil {
		return err
	}
	now := s.now()
	if _, err := tx.Exec(ctx, `
		UPDATE applied_slas a
		SET is_frt_breached = a.is_frt_breached OR (
				a.frt_due_at IS NOT NULL AND a.frt_due_at <= $2 AND c.first_reply_created_at IS NULL),
			is_nrt_breached = a.is_nrt_breached OR (
				a.nrt_due_at IS NOT NULL AND a.nrt_due_at <= $2 AND c.status <> $3),
			is_rt_breached = a.is_rt_breached OR (
				a.rt_due_at IS NOT NULL AND a.rt_due_at <= $2 AND c.status <> $4)
		FROM conversations c
		WHERE a.conversation_id = c.id AND c.id = $1`,
		conversationID, now, core.StatusPending, core.StatusResolved); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func applySLA(ctx context.Context, tx pgx.Tx, accountID, conversationID uuid.UUID, now time.Time) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM applied_slas WHERE conversation_id = $1)`, conversationID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	var policyID uuid.UUID
	var frt, nrt, rt *int
	var onlyBH, hoursOn bool
	var hours []byte
	err := tx.QueryRow(ctx, `
		SELECT p.id, p.frt_threshold_seconds, p.nrt_threshold_seconds, p.rt_threshold_seconds, p.only_business_hours,
			i.business_hours_enabled, i.business_hours
		FROM sla_policies p
		JOIN conversations c ON c.id = $2
		JOIN inboxes i ON i.id = c.inbox_id
		WHERE p.account_id = $1
		ORDER BY p.name LIMIT 1`, accountID, conversationID,
	).Scan(&policyID, &frt, &nrt, &rt, &onlyBH, &hoursOn, &hours)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil
		}
		return err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	var frtDue, rtDue any
	if frt != nil {
		frtDue = dueAt(now, *frt, onlyBH, hoursOn, hours)
	}
	if rt != nil {
		rtDue = dueAt(now, *rt, onlyBH, hoursOn, hours)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO applied_slas (id, account_id, conversation_id, sla_policy_id, frt_due_at, rt_due_at)
		VALUES ($1,$2,$3,$4,$5,$6)`,
		id, accountID, conversationID, policyID, frtDue, rtDue)
	return err
}

func dueAt(now time.Time, seconds int, onlyBH, hoursOn bool, raw []byte) time.Time {
	if onlyBH && hoursOn {
		return AddBusinessDuration(now, seconds, raw)
	}
	return now.Add(time.Duration(seconds) * time.Second)
}

func slaDue(ctx context.Context, tx pgx.Tx, conversationID uuid.UUID, now time.Time, seconds int) time.Time {
	var onlyBH, hoursOn bool
	var hours []byte
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(p.only_business_hours, false), i.business_hours_enabled, i.business_hours
		FROM conversations c
		JOIN inboxes i ON i.id = c.inbox_id
		LEFT JOIN applied_slas a ON a.conversation_id = c.id
		LEFT JOIN sla_policies p ON p.id = a.sla_policy_id
		WHERE c.id = $1`, conversationID).Scan(&onlyBH, &hoursOn, &hours)
	if err != nil {
		return now.Add(time.Duration(seconds) * time.Second)
	}
	return dueAt(now, seconds, onlyBH, hoursOn, hours)
}
