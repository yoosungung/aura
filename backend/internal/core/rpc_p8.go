package core

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

func (s *Service) handleMCPList(msg *nats.Msg) {
	in, err := parseMCPInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListMCP(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	_ = msg.Respond(mcpListJSON(list))
}

func (s *Service) handleMCPUpsert(msg *nats.Msg) {
	in, err := parseMCPInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.UpsertMCP(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "mcp_server": encodeMCP(out)})
	_ = msg.Respond(body)
}

func (s *Service) handleMCPDelete(msg *nats.Msg) {
	in, err := parseMCPInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.DeleteMCP(context.Background(), in); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func (s *Service) handleMCPRotate(msg *nats.Msg) {
	in, err := parseMCPInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.RotateMCP(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "mcp_server": encodeMCP(out)})
	_ = msg.Respond(body)
}

func (s *Service) handleAgentSkillList(msg *nats.Msg) {
	in, err := parseAgentSkillInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListAgentSkills(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	_ = msg.Respond(skillListJSON(list))
}

func (s *Service) handleAgentSkillUpsert(msg *nats.Msg) {
	in, err := parseAgentSkillInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.UpsertAgentSkill(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "agent_skill": encodeSkill(out)})
	_ = msg.Respond(body)
}

func (s *Service) handleAgentSkillDelete(msg *nats.Msg) {
	in, err := parseAgentSkillInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.DeleteAgentSkill(context.Background(), in); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func parseMCPInput(msg *nats.Msg) (MCPInput, error) {
	var req struct {
		ActorUserID   string   `json:"actor_user_id"`
		AccountID     string   `json:"account_id"`
		MCPServerID   string   `json:"mcp_server_id"`
		Name          string   `json:"name"`
		URL           string   `json:"url"`
		AuthHeader    string   `json:"auth_header"`
		AllowedTools  []string `json:"allowed_tools"`
		HighRiskTools []string `json:"high_risk_tools"`
		Enabled       *bool    `json:"enabled"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return MCPInput{}, err
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		return MCPInput{}, err
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return MCPInput{}, err
	}
	return MCPInput{
		ActorUserID: actor, AccountID: accountID, ServerID: parseUUID(req.MCPServerID),
		Name: req.Name, URL: req.URL, AuthHeader: req.AuthHeader,
		AllowedTools: req.AllowedTools, HighRiskTools: req.HighRiskTools, Enabled: req.Enabled,
	}, nil
}

func parseAgentSkillInput(msg *nats.Msg) (AgentSkillInput, error) {
	var req struct {
		ActorUserID string `json:"actor_user_id"`
		AccountID   string `json:"account_id"`
		SkillID     string `json:"skill_id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Body        string `json:"body"`
		Enabled     *bool  `json:"enabled"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return AgentSkillInput{}, err
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		return AgentSkillInput{}, err
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return AgentSkillInput{}, err
	}
	return AgentSkillInput{
		ActorUserID: actor, AccountID: accountID, SkillID: parseUUID(req.SkillID),
		Name: req.Name, Description: req.Description, Body: req.Body, Enabled: req.Enabled,
	}, nil
}

func encodeMCP(s MCPServer) map[string]any {
	return map[string]any{
		"id": s.ID.String(), "name": s.Name, "url": s.URL, "auth_header": s.AuthHeader,
		"allowed_tools": s.AllowedTools, "high_risk_tools": s.HighRiskTools, "enabled": s.Enabled,
	}
}

func mcpListJSON(list []MCPServer) []byte {
	rows := make([]map[string]any, 0, len(list))
	for _, s := range list {
		rows = append(rows, encodeMCP(s))
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "mcp_servers": rows})
	return body
}

func encodeSkill(s AgentSkill) map[string]any {
	return map[string]any{
		"id": s.ID.String(), "name": s.Name, "description": s.Description, "body": s.Body, "enabled": s.Enabled,
	}
}

func skillListJSON(list []AgentSkill) []byte {
	rows := make([]map[string]any, 0, len(list))
	for _, s := range list {
		rows = append(rows, encodeSkill(s))
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "agent_skills": rows})
	return body
}
