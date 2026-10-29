package core

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type MemberInput struct {
	ActorUserID uuid.UUID
	AccountID   uuid.UUID
	InboxID     uuid.UUID
	UserID      uuid.UUID
}

type InboxMember struct {
	UserID uuid.UUID
	Email  string
	Name   string
}

func (s *Service) AddInboxMember(ctx context.Context, in MemberInput) error {
	return s.withAdminInbox(ctx, in, func(tx pgx.Tx) error {
		var ok bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM account_users WHERE account_id = $1 AND user_id = $2)`,
			in.AccountID, in.UserID,
		).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return ErrNotFound
		}
		id, err := uuid.NewV7()
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO inbox_members (id, account_id, inbox_id, user_id)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (inbox_id, user_id) DO NOTHING`,
			id, in.AccountID, in.InboxID, in.UserID)
		return err
	})
}

func (s *Service) RemoveInboxMember(ctx context.Context, in MemberInput) error {
	return s.withAdminInbox(ctx, in, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			DELETE FROM inbox_members WHERE account_id = $1 AND inbox_id = $2 AND user_id = $3`,
			in.AccountID, in.InboxID, in.UserID)
		return err
	})
}

func (s *Service) ListInboxMembers(ctx context.Context, in MemberInput) ([]InboxMember, error) {
	var out []InboxMember
	err := s.withAdminInbox(ctx, in, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT u.id, u.email, u.name
			FROM inbox_members m
			JOIN users u ON u.id = m.user_id
			WHERE m.account_id = $1 AND m.inbox_id = $2
			ORDER BY u.email`, in.AccountID, in.InboxID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var m InboxMember
			if err := rows.Scan(&m.UserID, &m.Email, &m.Name); err != nil {
				return err
			}
			out = append(out, m)
		}
		return rows.Err()
	})
	if out == nil {
		out = []InboxMember{}
	}
	return out, err
}

func (s *Service) withAdminInbox(ctx context.Context, in MemberInput, fn func(pgx.Tx) error) error {
	if in.ActorUserID == uuid.Nil || in.AccountID == uuid.Nil || in.InboxID == uuid.Nil {
		return ErrNotFound
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
	if role != "administrator" {
		return ErrDenied
	}
	var inboxOK bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM inboxes WHERE id = $1)`, in.InboxID).Scan(&inboxOK); err != nil {
		return err
	}
	if !inboxOK {
		return ErrNotFound
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
