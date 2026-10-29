package core

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/ingest"
)

const (
	SubjectCreate            = "helpdesk.rpc.conversations.create"
	SubjectTransition        = "helpdesk.rpc.conversations.transition"
	SubjectAuthLogin         = "helpdesk.rpc.auth.login"
	SubjectAuthRefresh       = "helpdesk.rpc.auth.refresh"
	SubjectAuthLogout        = "helpdesk.rpc.auth.logout"
	SubjectInboxMemberAdd    = "helpdesk.rpc.inbox_members.add"
	SubjectInboxMemberRemove = "helpdesk.rpc.inbox_members.remove"
	SubjectInboxMemberList   = "helpdesk.rpc.inbox_members.list"
	SubjectAssign            = "helpdesk.rpc.conversations.assign"
	SubjectNote              = "helpdesk.rpc.conversations.note"
	SubjectSnooze            = "helpdesk.rpc.conversations.snooze"
	QueueGroup               = "svc-core"
)

type createReq struct {
	AccountID string `json:"account_id"`
	InboxID   string `json:"inbox_id"`
	SourceID  string `json:"source_id"`
	Name      string `json:"name"`
	TraceID   string `json:"trace_id"`
}

type transitionReq struct {
	AccountID       string  `json:"account_id"`
	ConversationID  string  `json:"conversation_id"`
	NewStatus       string  `json:"new_status"`
	ExpectedVersion int     `json:"expected_version"`
	ActorType       string  `json:"actor_type"`
	ActorID         *string `json:"actor_id"`
	TraceID         string  `json:"trace_id"`
}

func Serve(ctx context.Context, nc *nats.Conn, js jetstream.JetStream, db DB) error {
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		return err
	}
	s := &Service{DB: db, JS: js}
	subCreate, err := nc.QueueSubscribe(SubjectCreate, QueueGroup, func(msg *nats.Msg) {
		s.handleCreate(msg)
	})
	if err != nil {
		return err
	}
	defer subCreate.Unsubscribe()
	subTr, err := nc.QueueSubscribe(SubjectTransition, QueueGroup, func(msg *nats.Msg) {
		s.handleTransition(msg)
	})
	if err != nil {
		return err
	}
	defer subTr.Unsubscribe()
	subLogin, err := nc.QueueSubscribe(SubjectAuthLogin, QueueGroup, func(msg *nats.Msg) {
		s.handleLogin(msg)
	})
	if err != nil {
		return err
	}
	defer subLogin.Unsubscribe()
	subRefresh, err := nc.QueueSubscribe(SubjectAuthRefresh, QueueGroup, func(msg *nats.Msg) {
		s.handleRefresh(msg)
	})
	if err != nil {
		return err
	}
	defer subRefresh.Unsubscribe()
	subLogout, err := nc.QueueSubscribe(SubjectAuthLogout, QueueGroup, func(msg *nats.Msg) {
		s.handleLogout(msg)
	})
	if err != nil {
		return err
	}
	defer subLogout.Unsubscribe()
	subAdd, err := nc.QueueSubscribe(SubjectInboxMemberAdd, QueueGroup, func(msg *nats.Msg) {
		s.handleMemberMutate(msg, s.AddInboxMember)
	})
	if err != nil {
		return err
	}
	defer subAdd.Unsubscribe()
	subRemove, err := nc.QueueSubscribe(SubjectInboxMemberRemove, QueueGroup, func(msg *nats.Msg) {
		s.handleMemberMutate(msg, s.RemoveInboxMember)
	})
	if err != nil {
		return err
	}
	defer subRemove.Unsubscribe()
	subList, err := nc.QueueSubscribe(SubjectInboxMemberList, QueueGroup, func(msg *nats.Msg) {
		s.handleMemberList(msg)
	})
	if err != nil {
		return err
	}
	defer subList.Unsubscribe()
	subAssign, err := nc.QueueSubscribe(SubjectAssign, QueueGroup, func(msg *nats.Msg) {
		s.handleAssign(msg)
	})
	if err != nil {
		return err
	}
	defer subAssign.Unsubscribe()
	subNote, err := nc.QueueSubscribe(SubjectNote, QueueGroup, func(msg *nats.Msg) {
		s.handleNote(msg)
	})
	if err != nil {
		return err
	}
	defer subNote.Unsubscribe()
	subSnooze, err := nc.QueueSubscribe(SubjectSnooze, QueueGroup, func(msg *nats.Msg) {
		s.handleSnooze(msg)
	})
	if err != nil {
		return err
	}
	defer subSnooze.Unsubscribe()
	cc, err := s.consumeSnoozeWakes(ctx)
	if err != nil {
		return err
	}
	defer cc.Stop()
	if err := nc.Flush(); err != nil {
		return err
	}
	<-ctx.Done()
	return ctx.Err()
}

func (s *Service) handleCreate(msg *nats.Msg) {
	var req createReq
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	inboxID, err := uuid.Parse(req.InboxID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.Create(context.Background(), CreateInput{
		AccountID: accountID,
		InboxID:   inboxID,
		SourceID:  req.SourceID,
		Name:      req.Name,
		TraceID:   req.TraceID,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok":               true,
		"contact_id":       out.ContactID.String(),
		"contact_inbox_id": out.ContactInboxID.String(),
		"conversation_id":  out.ConversationID.String(),
		"display_id":       out.DisplayID,
		"status":           out.Status,
		"version":          out.Version,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleTransition(msg *nats.Msg) {
	var req transitionReq
	if err := json.Unmarshal(msg.Data, &req); err != nil {
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
	var actorID *uuid.UUID
	if req.ActorID != nil && *req.ActorID != "" {
		id, err := uuid.Parse(*req.ActorID)
		if err != nil {
			_ = msg.Respond(rpcErr(err))
			return
		}
		actorID = &id
	}
	out, err := s.Transition(context.Background(), TransitionInput{
		AccountID:       accountID,
		ConversationID:  convID,
		NewStatus:       req.NewStatus,
		ExpectedVersion: req.ExpectedVersion,
		ActorType:       req.ActorType,
		ActorID:         actorID,
		TraceID:         req.TraceID,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok":      true,
		"status":  out.Status,
		"version": out.Version,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleAssign(msg *nats.Msg) {
	var req struct {
		ActorUserID     string `json:"actor_user_id"`
		AccountID       string `json:"account_id"`
		ConversationID  string `json:"conversation_id"`
		AssigneeID      string `json:"assignee_id"`
		ExpectedVersion int    `json:"expected_version"`
		TraceID         string `json:"trace_id"`
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
	assignee, err := uuid.Parse(req.AssigneeID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.Assign(context.Background(), AssignInput{
		ActorUserID: actor, AccountID: accountID, ConversationID: convID,
		AssigneeID: assignee, ExpectedVersion: req.ExpectedVersion, TraceID: req.TraceID,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok":          true,
		"assignee_id": out.AssigneeID.String(),
		"status":      out.Status,
		"version":     out.Version,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleNote(msg *nats.Msg) {
	var req struct {
		ActorUserID    string `json:"actor_user_id"`
		AccountID      string `json:"account_id"`
		ConversationID string `json:"conversation_id"`
		Content        string `json:"content"`
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
	out, err := s.AddNote(context.Background(), NoteInput{
		ActorUserID: actor, AccountID: accountID, ConversationID: convID,
		Content: req.Content, TraceID: req.TraceID,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok":               true,
		"message_id":       out.MessageID.String(),
		"inbox_id":         out.InboxID.String(),
		"conversation_id":  out.ConversationID.String(),
		"contact_id":       out.ContactID.String(),
		"contact_inbox_id": out.ContactInboxID.String(),
		"sender_id":        out.SenderID.String(),
		"content":          out.Content,
		"private":          out.Private,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleSnooze(msg *nats.Msg) {
	var req struct {
		ActorUserID     string `json:"actor_user_id"`
		AccountID       string `json:"account_id"`
		ConversationID  string `json:"conversation_id"`
		SnoozedUntil    string `json:"snoozed_until"`
		ExpectedVersion int    `json:"expected_version"`
		TraceID         string `json:"trace_id"`
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
	until, err := time.Parse(time.RFC3339Nano, req.SnoozedUntil)
	if err != nil {
		_ = msg.Respond(rpcErr(ErrInvalid))
		return
	}
	out, err := s.Snooze(context.Background(), SnoozeInput{
		ActorUserID: actor, AccountID: accountID, ConversationID: convID,
		Until: until, ExpectedVersion: req.ExpectedVersion, TraceID: req.TraceID,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok":            true,
		"status":        out.Status,
		"version":       out.Version,
		"snoozed_until": out.SnoozedUntil.Format(time.RFC3339),
	})
	_ = msg.Respond(body)
}

func (s *Service) handleLogin(msg *nats.Msg) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.Login(context.Background(), LoginInput{Email: req.Email, Password: req.Password})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	_ = msg.Respond(authOK(out))
}

func (s *Service) handleRefresh(msg *nats.Msg) {
	var req struct {
		SessionToken string `json:"session_token"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.Refresh(context.Background(), req.SessionToken)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	_ = msg.Respond(authOK(out))
}

func (s *Service) handleLogout(msg *nats.Msg) {
	var req struct {
		SessionToken string `json:"session_token"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.Logout(context.Background(), req.SessionToken); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

type memberReq struct {
	ActorUserID string `json:"actor_user_id"`
	AccountID   string `json:"account_id"`
	InboxID     string `json:"inbox_id"`
	UserID      string `json:"user_id"`
}

func parseMemberInput(msg *nats.Msg) (MemberInput, error) {
	var req memberReq
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return MemberInput{}, err
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		return MemberInput{}, err
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return MemberInput{}, err
	}
	inboxID, err := uuid.Parse(req.InboxID)
	if err != nil {
		return MemberInput{}, err
	}
	in := MemberInput{ActorUserID: actor, AccountID: accountID, InboxID: inboxID}
	if req.UserID != "" {
		userID, err := uuid.Parse(req.UserID)
		if err != nil {
			return MemberInput{}, err
		}
		in.UserID = userID
	}
	return in, nil
}

func (s *Service) handleMemberMutate(msg *nats.Msg, fn func(context.Context, MemberInput) error) {
	in, err := parseMemberInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := fn(context.Background(), in); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func (s *Service) handleMemberList(msg *nats.Msg) {
	in, err := parseMemberInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListInboxMembers(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	members := make([]map[string]any, 0, len(list))
	for _, m := range list {
		members = append(members, map[string]any{
			"user_id": m.UserID.String(),
			"email":   m.Email,
			"name":    m.Name,
		})
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "members": members})
	_ = msg.Respond(body)
}

func authOK(out AuthResult) []byte {
	accounts := make([]map[string]any, 0, len(out.Accounts))
	for _, a := range out.Accounts {
		ids := make([]string, 0, len(a.InboxIDs))
		for _, id := range a.InboxIDs {
			ids = append(ids, id.String())
		}
		accounts = append(accounts, map[string]any{
			"account_id": a.AccountID.String(),
			"role":       a.Role,
			"inbox_ids":  ids,
		})
	}
	body, _ := json.Marshal(map[string]any{
		"ok":            true,
		"user_id":       out.UserID.String(),
		"email":         out.Email,
		"name":          out.Name,
		"session_id":    out.SessionID.String(),
		"session_token": out.SessionToken,
		"accounts":      accounts,
	})
	return body
}

func rpcErr(err error) []byte {
	code := err.Error()
	if errors.Is(err, ErrConflict) {
		code = ErrConflict.Error()
	} else if errors.Is(err, ErrForbidden) {
		code = ErrForbidden.Error()
	} else if errors.Is(err, ErrNotFound) {
		code = ErrNotFound.Error()
	} else if errors.Is(err, ErrUnauthorized) {
		code = ErrUnauthorized.Error()
	} else if errors.Is(err, ErrDenied) {
		code = ErrDenied.Error()
	} else if errors.Is(err, ErrInvalid) {
		code = ErrInvalid.Error()
	}
	body, _ := json.Marshal(map[string]any{"ok": false, "error": code})
	return body
}
