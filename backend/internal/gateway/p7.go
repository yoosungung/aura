package gateway

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

func (s *Server) handleEgo(w http.ResponseWriter, r *http.Request) {
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
	contactID, err := uuid.Parse(r.PathValue("contact_id"))
	if err != nil {
		http.Error(w, "invalid contact", http.StatusBadRequest)
		return
	}
	if s.Service.AI == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	nodes, err := s.Service.AI.Ego(r.Context(), tok.UserID, accountID, contactID)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	rows := make([]map[string]any, 0, len(nodes))
	for _, n := range nodes {
		rows = append(rows, map[string]any{
			"id": n.ID.String(), "entity_type": n.EntityType, "name": n.Name,
			"properties": n.Properties, "relation_type": n.RelationType, "hop": n.Hop,
		})
	}
	writeJSON(w, map[string]any{"nodes": rows})
}

func (s *Server) handleToolApprove(w http.ResponseWriter, r *http.Request) {
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
	conversationID, err := uuid.Parse(r.PathValue("conversation_id"))
	if err != nil {
		http.Error(w, "invalid conversation", http.StatusBadRequest)
		return
	}
	executionID, err := uuid.Parse(r.PathValue("execution_id"))
	if err != nil {
		http.Error(w, "invalid execution", http.StatusBadRequest)
		return
	}
	if s.Service.AI == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := s.Service.AI.ApproveTool(r.Context(), tok.UserID, accountID, conversationID, executionID); err != nil {
		writeCatalogErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) handleContactPurge(w http.ResponseWriter, r *http.Request) {
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
	contactID, err := uuid.Parse(r.PathValue("contact_id"))
	if err != nil {
		http.Error(w, "invalid contact", http.StatusBadRequest)
		return
	}
	if s.Service.AI == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := s.Service.AI.PurgeContact(r.Context(), tok.UserID, accountID, contactID); err != nil {
		writeCatalogErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (r *natsRPC) Ego(ctx context.Context, actor, account, contact uuid.UUID) ([]EgoNode, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "contact_id": contact.String(),
	})
	if err != nil {
		return nil, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectOntologyEgo, body)
	if err != nil {
		return nil, err
	}
	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
		Nodes []struct {
			ID           string         `json:"id"`
			EntityType   string         `json:"entity_type"`
			Name         string         `json:"name"`
			Properties   map[string]any `json:"properties"`
			RelationType string         `json:"relation_type"`
			Hop          int            `json:"hop"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, catalogRPCErr(out.Error)
	}
	rows := make([]EgoNode, 0, len(out.Nodes))
	for _, n := range out.Nodes {
		rows = append(rows, EgoNode{
			ID: parseUUID(n.ID), EntityType: n.EntityType, Name: n.Name,
			Properties: n.Properties, RelationType: n.RelationType, Hop: n.Hop,
		})
	}
	return rows, nil
}

func (r *natsRPC) ApproveTool(ctx context.Context, actor, account, conversation, execution uuid.UUID) error {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"conversation_id": conversation.String(), "execution_id": execution.String(),
	})
	if err != nil {
		return err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectToolsApprove, body)
	if err != nil {
		return err
	}
	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return err
	}
	if !out.OK {
		return catalogRPCErr(out.Error)
	}
	return nil
}

func (r *natsRPC) PurgeContact(ctx context.Context, actor, account, contact uuid.UUID) error {
	body, err := json.Marshal(map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "contact_id": contact.String(),
	})
	if err != nil {
		return err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectContactPurge, body)
	if err != nil {
		return err
	}
	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return err
	}
	if !out.OK {
		return catalogRPCErr(out.Error)
	}
	return nil
}
