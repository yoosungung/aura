package gateway

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

type MCPOut struct {
	ID            uuid.UUID
	Name          string
	URL           string
	AuthHeader    string
	AllowedTools  []string
	HighRiskTools []string
	Enabled       bool
}

type MCPStore interface {
	ListMCP(ctx context.Context, actor, account uuid.UUID) ([]MCPOut, error)
	UpsertMCP(ctx context.Context, actor, account uuid.UUID, name, rawURL, auth string, allowed, high []string, enabled *bool) (MCPOut, error)
	DeleteMCP(ctx context.Context, actor, account, server uuid.UUID) error
	RotateMCP(ctx context.Context, actor, account, server uuid.UUID, auth string) (MCPOut, error)
}

type SkillOut struct {
	ID          uuid.UUID
	Name        string
	Description string
	Body        string
	Enabled     bool
}

type SkillStore interface {
	ListSkills(ctx context.Context, actor, account uuid.UUID) ([]SkillOut, error)
	UpsertSkill(ctx context.Context, actor, account uuid.UUID, name, description, body string, enabled *bool) (SkillOut, error)
	DeleteSkill(ctx context.Context, actor, account, skill uuid.UUID) error
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	if s.Service.MCP == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	tok, err := s.userTok(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	accountID, err := s.accountPath(r, tok)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := s.Service.MCP.ListMCP(r.Context(), tok.UserID, accountID)
		if err != nil {
			writeCatalogErr(w, err)
			return
		}
		rows := make([]map[string]any, 0, len(list))
		for _, item := range list {
			rows = append(rows, encodeMCPHTTP(item))
		}
		writeJSON(w, map[string]any{"mcp_servers": rows})
	case http.MethodPost:
		var body struct {
			Name          string   `json:"name"`
			URL           string   `json:"url"`
			AuthHeader    string   `json:"auth_header"`
			AllowedTools  []string `json:"allowed_tools"`
			HighRiskTools []string `json:"high_risk_tools"`
			Enabled       *bool    `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		got, err := s.Service.MCP.UpsertMCP(r.Context(), tok.UserID, accountID, body.Name, body.URL, body.AuthHeader, body.AllowedTools, body.HighRiskTools, body.Enabled)
		if err != nil {
			writeCatalogErr(w, err)
			return
		}
		writeJSON(w, encodeMCPHTTP(got))
	case http.MethodDelete:
		id, err := uuid.Parse(r.PathValue("mcp_server_id"))
		if err != nil {
			http.Error(w, "invalid mcp", http.StatusBadRequest)
			return
		}
		if err := s.Service.MCP.DeleteMCP(r.Context(), tok.UserID, accountID, id); err != nil {
			writeCatalogErr(w, err)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleMCPRotate(w http.ResponseWriter, r *http.Request) {
	if s.Service.MCP == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	tok, err := s.userTok(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	accountID, err := s.accountPath(r, tok)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	id, err := uuid.Parse(r.PathValue("mcp_server_id"))
	if err != nil {
		http.Error(w, "invalid mcp", http.StatusBadRequest)
		return
	}
	var body struct {
		AuthHeader string `json:"auth_header"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	got, err := s.Service.MCP.RotateMCP(r.Context(), tok.UserID, accountID, id, body.AuthHeader)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	writeJSON(w, encodeMCPHTTP(got))
}

func (s *Server) handleAgentSkills(w http.ResponseWriter, r *http.Request) {
	if s.Service.Skills == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	tok, err := s.userTok(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	accountID, err := s.accountPath(r, tok)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := s.Service.Skills.ListSkills(r.Context(), tok.UserID, accountID)
		if err != nil {
			writeCatalogErr(w, err)
			return
		}
		rows := make([]map[string]any, 0, len(list))
		for _, item := range list {
			rows = append(rows, encodeSkillHTTP(item))
		}
		writeJSON(w, map[string]any{"agent_skills": rows})
	case http.MethodPost:
		var body struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Body        string `json:"body"`
			Enabled     *bool  `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		got, err := s.Service.Skills.UpsertSkill(r.Context(), tok.UserID, accountID, body.Name, body.Description, body.Body, body.Enabled)
		if err != nil {
			writeCatalogErr(w, err)
			return
		}
		writeJSON(w, encodeSkillHTTP(got))
	case http.MethodDelete:
		id, err := uuid.Parse(r.PathValue("skill_id"))
		if err != nil {
			http.Error(w, "invalid skill", http.StatusBadRequest)
			return
		}
		if err := s.Service.Skills.DeleteSkill(r.Context(), tok.UserID, accountID, id); err != nil {
			writeCatalogErr(w, err)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func encodeMCPHTTP(s MCPOut) map[string]any {
	return map[string]any{
		"id": s.ID.String(), "name": s.Name, "url": s.URL, "auth_header": s.AuthHeader,
		"allowed_tools": s.AllowedTools, "high_risk_tools": s.HighRiskTools, "enabled": s.Enabled,
	}
}

func encodeSkillHTTP(s SkillOut) map[string]any {
	return map[string]any{
		"id": s.ID.String(), "name": s.Name, "description": s.Description, "body": s.Body, "enabled": s.Enabled,
	}
}

func (r *natsRPC) ListMCP(ctx context.Context, actor, account uuid.UUID) ([]MCPOut, error) {
	raw, err := r.call(ctx, core.SubjectMCPList, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
	})
	if err != nil {
		return nil, err
	}
	return decodeMCPList(raw["mcp_servers"])
}

func (r *natsRPC) UpsertMCP(ctx context.Context, actor, account uuid.UUID, name, rawURL, auth string, allowed, high []string, enabled *bool) (MCPOut, error) {
	payload := map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"name": name, "url": rawURL, "auth_header": auth,
		"allowed_tools": allowed, "high_risk_tools": high,
	}
	if enabled != nil {
		payload["enabled"] = *enabled
	}
	raw, err := r.call(ctx, core.SubjectMCPUpsert, payload)
	if err != nil {
		return MCPOut{}, err
	}
	row, _ := raw["mcp_server"].(map[string]any)
	return decodeMCP(row), nil
}

func (r *natsRPC) DeleteMCP(ctx context.Context, actor, account, server uuid.UUID) error {
	_, err := r.call(ctx, core.SubjectMCPDelete, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "mcp_server_id": server.String(),
	})
	return err
}

func (r *natsRPC) RotateMCP(ctx context.Context, actor, account, server uuid.UUID, auth string) (MCPOut, error) {
	raw, err := r.call(ctx, core.SubjectMCPRotate, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"mcp_server_id": server.String(), "auth_header": auth,
	})
	if err != nil {
		return MCPOut{}, err
	}
	row, _ := raw["mcp_server"].(map[string]any)
	return decodeMCP(row), nil
}

func (r *natsRPC) ListSkills(ctx context.Context, actor, account uuid.UUID) ([]SkillOut, error) {
	raw, err := r.call(ctx, core.SubjectAgentSkillList, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
	})
	if err != nil {
		return nil, err
	}
	return decodeSkillList(raw["agent_skills"])
}

func (r *natsRPC) UpsertSkill(ctx context.Context, actor, account uuid.UUID, name, description, body string, enabled *bool) (SkillOut, error) {
	payload := map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"name": name, "description": description, "body": body,
	}
	if enabled != nil {
		payload["enabled"] = *enabled
	}
	raw, err := r.call(ctx, core.SubjectAgentSkillUpsert, payload)
	if err != nil {
		return SkillOut{}, err
	}
	row, _ := raw["agent_skill"].(map[string]any)
	return decodeSkill(row), nil
}

func (r *natsRPC) DeleteSkill(ctx context.Context, actor, account, skill uuid.UUID) error {
	_, err := r.call(ctx, core.SubjectAgentSkillDelete, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "skill_id": skill.String(),
	})
	return err
}

func decodeMCPList(v any) ([]MCPOut, error) {
	raw, _ := v.([]any)
	out := make([]MCPOut, 0, len(raw))
	for _, item := range raw {
		m, _ := item.(map[string]any)
		out = append(out, decodeMCP(m))
	}
	return out, nil
}

func decodeMCP(m map[string]any) MCPOut {
	if m == nil {
		return MCPOut{}
	}
	return MCPOut{
		ID: parseUUID(asString(m["id"])), Name: asString(m["name"]), URL: asString(m["url"]),
		AuthHeader: asString(m["auth_header"]), AllowedTools: asStringSlice(m["allowed_tools"]),
		HighRiskTools: asStringSlice(m["high_risk_tools"]), Enabled: asBool(m["enabled"]),
	}
}

func decodeSkillList(v any) ([]SkillOut, error) {
	raw, _ := v.([]any)
	out := make([]SkillOut, 0, len(raw))
	for _, item := range raw {
		m, _ := item.(map[string]any)
		out = append(out, decodeSkill(m))
	}
	return out, nil
}

func decodeSkill(m map[string]any) SkillOut {
	if m == nil {
		return SkillOut{}
	}
	return SkillOut{
		ID: parseUUID(asString(m["id"])), Name: asString(m["name"]),
		Description: asString(m["description"]), Body: asString(m["body"]), Enabled: asBool(m["enabled"]),
	}
}

func asStringSlice(v any) []string {
	raw, _ := v.([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		out = append(out, asString(item))
	}
	return out
}

func asBool(v any) bool {
	b, _ := v.(bool)
	return b
}
