package routing

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yoosungung/aura/internal/core"
)

type DB interface {
	Begin(context.Context) (pgx.Tx, error)
}

type Assigner interface {
	Assign(ctx context.Context, in core.AssignInput) (core.AssignResult, error)
}

type Service struct {
	DB       DB
	Capacity Store
	Assigner Assigner
	Now      func() time.Time
}

func (s *Service) Route(ctx context.Context, accountID, inboxID, conversationID uuid.UUID, traceID string) error {
	if s.Assigner == nil || accountID == uuid.Nil || conversationID == uuid.Nil {
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
	var status string
	var version int
	var assignee uuid.UUID
	var enabled bool
	var capacity int
	err = tx.QueryRow(ctx, `
		SELECT c.status, c.version, COALESCE(c.assignee_id, '00000000-0000-0000-0000-000000000000'::uuid),
			i.enable_auto_assignment, i.auto_assignment_capacity
		FROM conversations c JOIN inboxes i ON i.id = c.inbox_id
		WHERE c.id = $1`, conversationID,
	).Scan(&status, &version, &assignee, &enabled, &capacity)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil
		}
		return err
	}
	if !enabled || status != core.StatusUnassigned || assignee != uuid.Nil {
		return tx.Commit(ctx)
	}
	rows, err := tx.Query(ctx, `
		SELECT u.id FROM inbox_members m
		JOIN users u ON u.id = m.user_id
		WHERE m.inbox_id = $1 AND u.availability_status = 'online'
		ORDER BY u.id`, inboxID)
	if err != nil {
		return err
	}
	var agents []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		agents = append(agents, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if len(agents) == 0 {
		return nil
	}
	start, err := s.Capacity.NextCursor(ctx, accountID, inboxID, len(agents))
	if err != nil {
		return err
	}
	for i := 0; i < len(agents); i++ {
		agent := agents[(start+i)%len(agents)]
		ok, err := s.Capacity.TryAcquire(ctx, accountID, agent, capacity)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		if _, err := s.Assigner.Assign(ctx, core.AssignInput{
			ActorUserID: agent, AccountID: accountID, ConversationID: conversationID,
			AssigneeID: agent, ExpectedVersion: version, TraceID: traceID,
		}); err != nil {
			_ = s.Capacity.Release(ctx, accountID, agent)
			if err == core.ErrConflict || err == core.ErrDenied {
				continue
			}
			return err
		}
		return nil
	}
	return nil
}
