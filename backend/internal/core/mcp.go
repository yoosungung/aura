package core

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type MCPInput struct {
	ActorUserID   uuid.UUID
	AccountID     uuid.UUID
	ServerID      uuid.UUID
	Name          string
	URL           string
	AuthHeader    string
	AllowedTools  []string
	HighRiskTools []string
	Enabled       *bool
}

type MCPServer struct {
	ID            uuid.UUID
	Name          string
	URL           string
	AuthHeader    string
	AllowedTools  []string
	HighRiskTools []string
	Enabled       bool
}

func (s *Service) UpsertMCP(ctx context.Context, in MCPInput) (MCPServer, error) {
	name := strings.TrimSpace(in.Name)
	rawURL := strings.TrimSpace(in.URL)
	if name == "" || utf8.RuneCountInString(name) > 100 {
		return MCPServer{}, ErrInvalid
	}
	if err := validWebhookURL(rawURL); err != nil {
		return MCPServer{}, err
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	allowed := in.AllowedTools
	if allowed == nil {
		allowed = []string{}
	}
	high := in.HighRiskTools
	if high == nil {
		high = []string{}
	}
	var out MCPServer
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		return tx.QueryRow(ctx, `
			INSERT INTO mcp_servers (id, account_id, name, url, auth_header, allowed_tools, high_risk_tools, enabled)
			VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (account_id, name) DO UPDATE SET
				url = EXCLUDED.url,
				auth_header = CASE WHEN EXCLUDED.auth_header = '' THEN mcp_servers.auth_header ELSE EXCLUDED.auth_header END,
				allowed_tools = EXCLUDED.allowed_tools,
				high_risk_tools = EXCLUDED.high_risk_tools,
				enabled = EXCLUDED.enabled,
				updated_at = CURRENT_TIMESTAMP
			RETURNING id, name, url, auth_header, allowed_tools, high_risk_tools, enabled`,
			in.AccountID, name, rawURL, strings.TrimSpace(in.AuthHeader), allowed, high, enabled,
		).Scan(&out.ID, &out.Name, &out.URL, &out.AuthHeader, &out.AllowedTools, &out.HighRiskTools, &out.Enabled)
	})
	return out, err
}

func (s *Service) ListMCP(ctx context.Context, in MCPInput) ([]MCPServer, error) {
	var out []MCPServer
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, `
			SELECT id, name, url, auth_header, allowed_tools, high_risk_tools, enabled
			FROM mcp_servers ORDER BY name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row MCPServer
			if err := rows.Scan(&row.ID, &row.Name, &row.URL, &row.AuthHeader, &row.AllowedTools, &row.HighRiskTools, &row.Enabled); err != nil {
				return err
			}
			if row.AllowedTools == nil {
				row.AllowedTools = []string{}
			}
			if row.HighRiskTools == nil {
				row.HighRiskTools = []string{}
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if out == nil {
		out = []MCPServer{}
	}
	return out, err
}

func (s *Service) DeleteMCP(ctx context.Context, in MCPInput) error {
	if in.ServerID == uuid.Nil {
		return ErrNotFound
	}
	return s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		tag, err := tx.Exec(ctx, `DELETE FROM mcp_servers WHERE id = $1`, in.ServerID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func (s *Service) RotateMCP(ctx context.Context, in MCPInput) (MCPServer, error) {
	if in.ServerID == uuid.Nil || strings.TrimSpace(in.AuthHeader) == "" {
		return MCPServer{}, ErrInvalid
	}
	var out MCPServer
	err := s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		err := tx.QueryRow(ctx, `
			UPDATE mcp_servers SET auth_header = $2, updated_at = CURRENT_TIMESTAMP
			WHERE id = $1
			RETURNING id, name, url, auth_header, allowed_tools, high_risk_tools, enabled`,
			in.ServerID, strings.TrimSpace(in.AuthHeader),
		).Scan(&out.ID, &out.Name, &out.URL, &out.AuthHeader, &out.AllowedTools, &out.HighRiskTools, &out.Enabled)
		if err == pgx.ErrNoRows {
			return ErrNotFound
		}
		return err
	})
	return out, err
}
