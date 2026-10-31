package core

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type AgentSkillInput struct {
	ActorUserID uuid.UUID
	AccountID   uuid.UUID
	SkillID     uuid.UUID
	Name        string
	Description string
	Body        string
	Enabled     *bool
}

type AgentSkill struct {
	ID          uuid.UUID
	Name        string
	Description string
	Body        string
	Enabled     bool
}

func (s *Service) UpsertAgentSkill(ctx context.Context, in AgentSkillInput) (AgentSkill, error) {
	name := strings.TrimSpace(in.Name)
	body := strings.TrimSpace(in.Body)
	if name == "" || body == "" || utf8.RuneCountInString(name) > 100 {
		return AgentSkill{}, ErrInvalid
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	var out AgentSkill
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		return tx.QueryRow(ctx, `
			INSERT INTO agent_skills (id, account_id, name, description, body, enabled)
			VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
			ON CONFLICT (account_id, name) DO UPDATE SET
				description = EXCLUDED.description,
				body = EXCLUDED.body,
				enabled = EXCLUDED.enabled,
				updated_at = CURRENT_TIMESTAMP
			RETURNING id, name, description, body, enabled`,
			in.AccountID, name, strings.TrimSpace(in.Description), body, enabled,
		).Scan(&out.ID, &out.Name, &out.Description, &out.Body, &out.Enabled)
	})
	return out, err
}

func (s *Service) ListAgentSkills(ctx context.Context, in AgentSkillInput) ([]AgentSkill, error) {
	var out []AgentSkill
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, `SELECT id, name, description, body, enabled FROM agent_skills ORDER BY name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row AgentSkill
			if err := rows.Scan(&row.ID, &row.Name, &row.Description, &row.Body, &row.Enabled); err != nil {
				return err
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if out == nil {
		out = []AgentSkill{}
	}
	return out, err
}

func (s *Service) DeleteAgentSkill(ctx context.Context, in AgentSkillInput) error {
	if in.SkillID == uuid.Nil {
		return ErrNotFound
	}
	return s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		tag, err := tx.Exec(ctx, `DELETE FROM agent_skills WHERE id = $1`, in.SkillID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}
