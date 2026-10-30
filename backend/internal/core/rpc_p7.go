package core

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

func (s *Service) handleOntologyEgo(msg *nats.Msg) {
	var req struct {
		ActorUserID string `json:"actor_user_id"`
		AccountID   string `json:"account_id"`
		ContactID   string `json:"contact_id"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	contactID, err := uuid.Parse(req.ContactID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.EgoGraph(context.Background(), EgoInput{ActorUserID: actor, AccountID: accountID, ContactID: contactID})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, n := range list {
		rows = append(rows, map[string]any{
			"id": n.ID.String(), "entity_type": n.EntityType, "name": n.Name,
			"properties": n.Properties, "relation_type": n.RelationType, "hop": n.Hop,
		})
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "nodes": rows})
	_ = msg.Respond(body)
}

func (s *Service) handleToolsApprove(msg *nats.Msg) {
	var req struct {
		ActorUserID    string `json:"actor_user_id"`
		AccountID      string `json:"account_id"`
		ConversationID string `json:"conversation_id"`
		ExecutionID    string `json:"execution_id"`
		TraceID        string `json:"trace_id"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	convID, err := uuid.Parse(req.ConversationID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	execID, err := uuid.Parse(req.ExecutionID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.ApproveTool(context.Background(), ApproveInput{
		ActorUserID: actor, AccountID: accountID, ConversationID: convID,
		ExecutionID: execID, TraceID: req.TraceID,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "execution_id": out.ExecutionID.String(), "tool_name": out.ToolName,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleContactPurge(msg *nats.Msg) {
	var req struct {
		ActorUserID string `json:"actor_user_id"`
		AccountID   string `json:"account_id"`
		ContactID   string `json:"contact_id"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	contactID, err := uuid.Parse(req.ContactID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.PurgeContact(context.Background(), PurgeInput{
		ActorUserID: actor, AccountID: accountID, ContactID: contactID,
	}); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}
