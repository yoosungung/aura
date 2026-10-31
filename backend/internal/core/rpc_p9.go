package core

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

const (
	SubjectAuthPresence = "helpdesk.rpc.auth.presence"
	SubjectGreet        = "helpdesk.rpc.conversations.greet"
	SubjectInboxUpdate  = "helpdesk.rpc.inboxes.update"
)

func (s *Service) subscribeP9(nc *nats.Conn) error {
	subs := []struct {
		subject string
		handler nats.MsgHandler
	}{
		{SubjectAuthPresence, s.handlePresence},
		{SubjectGreet, s.handleGreet},
		{SubjectInboxUpdate, s.handleInboxUpdate},
	}
	for _, item := range subs {
		if _, err := nc.QueueSubscribe(item.subject, QueueGroup, item.handler); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) handlePresence(msg *nats.Msg) {
	var req struct {
		UserID    string `json:"user_id"`
		AccountID string `json:"account_id"`
		Status    string `json:"status"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	userID, err := uuid.Parse(req.UserID)
	if err != nil {
		_ = msg.Respond(rpcErr(ErrInvalid))
		return
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		_ = msg.Respond(rpcErr(ErrInvalid))
		return
	}
	if err := s.SetPresence(context.Background(), PresenceInput{
		UserID: userID, AccountID: accountID, Status: req.Status,
	}); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func (s *Service) handleGreet(msg *nats.Msg) {
	var req struct {
		AccountID      string `json:"account_id"`
		ConversationID string `json:"conversation_id"`
		TraceID        string `json:"trace_id"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		_ = msg.Respond(rpcErr(ErrInvalid))
		return
	}
	conversationID, err := uuid.Parse(req.ConversationID)
	if err != nil {
		_ = msg.Respond(rpcErr(ErrInvalid))
		return
	}
	if err := s.Greet(context.Background(), GreetInput{
		AccountID: accountID, ConversationID: conversationID, TraceID: req.TraceID,
	}); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func (s *Service) handleInboxUpdate(msg *nats.Msg) {
	var req struct {
		ActorUserID            string          `json:"actor_user_id"`
		AccountID              string          `json:"account_id"`
		InboxID                string          `json:"inbox_id"`
		GreetingMessage        string          `json:"greeting_message"`
		BusinessHoursEnabled   bool            `json:"business_hours_enabled"`
		BusinessHours          json.RawMessage `json:"business_hours"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	in, err := memberFromIDs(req.ActorUserID, req.AccountID, req.InboxID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	got, err := s.UpdateInbox(context.Background(), InboxUpdate{
		MemberInput:          in,
		GreetingMessage:      req.GreetingMessage,
		BusinessHoursEnabled: req.BusinessHoursEnabled,
		BusinessHours:        req.BusinessHours,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	_ = msg.Respond(inboxHMACBody(got))
}

func memberFromIDs(actor, account, inbox string) (MemberInput, error) {
	actorID, err := uuid.Parse(actor)
	if err != nil {
		return MemberInput{}, ErrInvalid
	}
	accountID, err := uuid.Parse(account)
	if err != nil {
		return MemberInput{}, ErrInvalid
	}
	inboxID, err := uuid.Parse(inbox)
	if err != nil {
		return MemberInput{}, ErrInvalid
	}
	return MemberInput{ActorUserID: actorID, AccountID: accountID, InboxID: inboxID}, nil
}
