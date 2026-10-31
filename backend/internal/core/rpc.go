package core

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/contracts"
	"github.com/yoosungung/aura/internal/ingest"
)

const (
	SubjectCreate               = "helpdesk.rpc.conversations.create"
	SubjectTransition           = "helpdesk.rpc.conversations.transition"
	SubjectAuthLogin            = "helpdesk.rpc.auth.login"
	SubjectAuthRefresh          = "helpdesk.rpc.auth.refresh"
	SubjectAuthLogout           = "helpdesk.rpc.auth.logout"
	SubjectAuthContact          = "helpdesk.rpc.auth.contact"
	SubjectInboxMemberAdd       = "helpdesk.rpc.inbox_members.add"
	SubjectInboxMemberRemove    = "helpdesk.rpc.inbox_members.remove"
	SubjectInboxMemberList      = "helpdesk.rpc.inbox_members.list"
	SubjectAssign               = "helpdesk.rpc.conversations.assign"
	SubjectNote                 = "helpdesk.rpc.conversations.note"
	SubjectSnooze               = "helpdesk.rpc.conversations.snooze"
	SubjectLabelAdd             = "helpdesk.rpc.conversations.label.add"
	SubjectLabelRemove          = "helpdesk.rpc.conversations.label.remove"
	SubjectLabelList            = "helpdesk.rpc.conversations.label.list"
	SubjectLabelCatalogList     = "helpdesk.rpc.labels.list"
	SubjectLabelCatalogCreate   = "helpdesk.rpc.labels.create"
	SubjectLabelCatalogDelete   = "helpdesk.rpc.labels.delete"
	SubjectCannedList           = "helpdesk.rpc.canned.list"
	SubjectCannedCreate         = "helpdesk.rpc.canned.create"
	SubjectCannedDelete         = "helpdesk.rpc.canned.delete"
	SubjectMacroList            = "helpdesk.rpc.macros.list"
	SubjectMacroCreate          = "helpdesk.rpc.macros.create"
	SubjectMacroDelete          = "helpdesk.rpc.macros.delete"
	SubjectMacroExecute         = "helpdesk.rpc.macros.execute"
	SubjectConversationsList    = "helpdesk.rpc.conversations.list"
	SubjectMessagesList         = "helpdesk.rpc.conversations.messages"
	SubjectContactsList         = "helpdesk.rpc.contacts.list"
	SubjectContactIdentify      = "helpdesk.rpc.contacts.identify"
	SubjectInboxResolveEmail    = "helpdesk.rpc.inboxes.resolve_email"
	SubjectInboxResolveKakao    = "helpdesk.rpc.inboxes.resolve_kakao"
	SubjectInboxGet             = "helpdesk.rpc.inboxes.get"
	SubjectInboxRotateHMAC      = "helpdesk.rpc.inboxes.rotate_hmac"
	SubjectResolveThread        = "helpdesk.rpc.conversations.resolve_thread"
	SubjectResolveKakao         = "helpdesk.rpc.conversations.resolve_kakao"
	SubjectEmailReply           = "helpdesk.rpc.conversations.email_reply"
	SubjectKakaoReply           = "helpdesk.rpc.conversations.kakao_reply"
	SubjectPlatformAccount      = "helpdesk.rpc.platform.accounts.create"
	SubjectPlatformUser         = "helpdesk.rpc.platform.users.create"
	SubjectWebhookList          = "helpdesk.rpc.webhooks.list"
	SubjectWebhookCreate        = "helpdesk.rpc.webhooks.create"
	SubjectWebhookDelete        = "helpdesk.rpc.webhooks.delete"
	SubjectReportsGet           = "helpdesk.rpc.reports.get"
	SubjectArticleList          = "helpdesk.rpc.articles.list"
	SubjectArticleCreate        = "helpdesk.rpc.articles.create"
	SubjectArticleDelete        = "helpdesk.rpc.articles.delete"
	SubjectArticleSearch        = "helpdesk.rpc.articles.search"
	SubjectContactConversations = "helpdesk.rpc.contacts.conversations"
	SubjectContactMessages      = "helpdesk.rpc.contacts.messages"
	SubjectOntologyEgo          = "helpdesk.rpc.ontology.ego"
	SubjectToolsApprove         = "helpdesk.rpc.tools.approve"
	SubjectContactPurge         = "helpdesk.rpc.contacts.purge"
	SubjectMCPList              = "helpdesk.rpc.mcp.list"
	SubjectMCPUpsert            = "helpdesk.rpc.mcp.upsert"
	SubjectMCPDelete            = "helpdesk.rpc.mcp.delete"
	SubjectMCPRotate            = "helpdesk.rpc.mcp.rotate"
	SubjectAgentSkillList       = "helpdesk.rpc.agent_skills.list"
	SubjectAgentSkillUpsert     = "helpdesk.rpc.agent_skills.upsert"
	SubjectAgentSkillDelete     = "helpdesk.rpc.agent_skills.delete"
	QueueGroup                  = "svc-core"
)

func Serve(ctx context.Context, nc *nats.Conn, js jetstream.JetStream, db DB) error {
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		return err
	}
	s := &Service{DB: db, JS: js, NC: nc, Archive: FilerPurge{Endpoint: os.Getenv("AURA_FILER_URL")}}
	if f, ok := s.Archive.(FilerPurge); ok && f.Endpoint == "" {
		s.Archive = FilerPurge{Endpoint: "http://127.0.0.1:8888"}
	}
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
	subContactAuth, err := nc.QueueSubscribe(SubjectAuthContact, QueueGroup, func(msg *nats.Msg) {
		s.handleContactAuth(msg)
	})
	if err != nil {
		return err
	}
	defer subContactAuth.Unsubscribe()
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
	subLabelAdd, err := nc.QueueSubscribe(SubjectLabelAdd, QueueGroup, func(msg *nats.Msg) {
		s.handleLabelAdd(msg)
	})
	if err != nil {
		return err
	}
	defer subLabelAdd.Unsubscribe()
	subLabelRemove, err := nc.QueueSubscribe(SubjectLabelRemove, QueueGroup, func(msg *nats.Msg) {
		s.handleLabelRemove(msg)
	})
	if err != nil {
		return err
	}
	defer subLabelRemove.Unsubscribe()
	subLabelList, err := nc.QueueSubscribe(SubjectLabelList, QueueGroup, func(msg *nats.Msg) {
		s.handleLabelList(msg)
	})
	if err != nil {
		return err
	}
	defer subLabelList.Unsubscribe()
	subConvList, err := nc.QueueSubscribe(SubjectConversationsList, QueueGroup, func(msg *nats.Msg) {
		s.handleConversationsList(msg)
	})
	if err != nil {
		return err
	}
	defer subConvList.Unsubscribe()
	subMsgList, err := nc.QueueSubscribe(SubjectMessagesList, QueueGroup, func(msg *nats.Msg) {
		s.handleMessagesList(msg)
	})
	if err != nil {
		return err
	}
	defer subMsgList.Unsubscribe()
	subContactList, err := nc.QueueSubscribe(SubjectContactsList, QueueGroup, func(msg *nats.Msg) {
		s.handleContactsList(msg)
	})
	if err != nil {
		return err
	}
	defer subContactList.Unsubscribe()
	subIdentify, err := nc.QueueSubscribe(SubjectContactIdentify, QueueGroup, func(msg *nats.Msg) {
		s.handleIdentify(msg)
	})
	if err != nil {
		return err
	}
	defer subIdentify.Unsubscribe()
	subResolveEmail, err := nc.QueueSubscribe(SubjectInboxResolveEmail, QueueGroup, func(msg *nats.Msg) {
		s.handleResolveInbox(msg)
	})
	if err != nil {
		return err
	}
	defer subResolveEmail.Unsubscribe()
	subResolveKakaoInbox, err := nc.QueueSubscribe(SubjectInboxResolveKakao, QueueGroup, s.handleResolveKakaoInbox)
	if err != nil {
		return err
	}
	defer subResolveKakaoInbox.Unsubscribe()
	subInboxGet, err := nc.QueueSubscribe(SubjectInboxGet, QueueGroup, s.handleInboxGet)
	if err != nil {
		return err
	}
	defer subInboxGet.Unsubscribe()
	subInboxRotate, err := nc.QueueSubscribe(SubjectInboxRotateHMAC, QueueGroup, s.handleInboxRotateHMAC)
	if err != nil {
		return err
	}
	defer subInboxRotate.Unsubscribe()
	subResolveThread, err := nc.QueueSubscribe(SubjectResolveThread, QueueGroup, func(msg *nats.Msg) {
		s.handleResolveThread(msg)
	})
	if err != nil {
		return err
	}
	defer subResolveThread.Unsubscribe()
	subResolveKakao, err := nc.QueueSubscribe(SubjectResolveKakao, QueueGroup, s.handleResolveKakao)
	if err != nil {
		return err
	}
	defer subResolveKakao.Unsubscribe()
	subEmailReply, err := nc.QueueSubscribe(SubjectEmailReply, QueueGroup, s.handleEmailReply)
	if err != nil {
		return err
	}
	defer subEmailReply.Unsubscribe()
	subKakaoReply, err := nc.QueueSubscribe(SubjectKakaoReply, QueueGroup, s.handleKakaoReply)
	if err != nil {
		return err
	}
	defer subKakaoReply.Unsubscribe()
	subLabelCatalogList, err := nc.QueueSubscribe(SubjectLabelCatalogList, QueueGroup, s.handleLabelCatalogList)
	if err != nil {
		return err
	}
	defer subLabelCatalogList.Unsubscribe()
	subLabelCatalogCreate, err := nc.QueueSubscribe(SubjectLabelCatalogCreate, QueueGroup, s.handleLabelCatalogCreate)
	if err != nil {
		return err
	}
	defer subLabelCatalogCreate.Unsubscribe()
	subLabelCatalogDelete, err := nc.QueueSubscribe(SubjectLabelCatalogDelete, QueueGroup, s.handleLabelCatalogDelete)
	if err != nil {
		return err
	}
	defer subLabelCatalogDelete.Unsubscribe()
	subCannedList, err := nc.QueueSubscribe(SubjectCannedList, QueueGroup, s.handleCannedList)
	if err != nil {
		return err
	}
	defer subCannedList.Unsubscribe()
	subCannedCreate, err := nc.QueueSubscribe(SubjectCannedCreate, QueueGroup, s.handleCannedCreate)
	if err != nil {
		return err
	}
	defer subCannedCreate.Unsubscribe()
	subCannedDelete, err := nc.QueueSubscribe(SubjectCannedDelete, QueueGroup, s.handleCannedDelete)
	if err != nil {
		return err
	}
	defer subCannedDelete.Unsubscribe()
	subMacroList, err := nc.QueueSubscribe(SubjectMacroList, QueueGroup, s.handleMacroList)
	if err != nil {
		return err
	}
	defer subMacroList.Unsubscribe()
	subMacroCreate, err := nc.QueueSubscribe(SubjectMacroCreate, QueueGroup, s.handleMacroCreate)
	if err != nil {
		return err
	}
	defer subMacroCreate.Unsubscribe()
	subMacroDelete, err := nc.QueueSubscribe(SubjectMacroDelete, QueueGroup, s.handleMacroDelete)
	if err != nil {
		return err
	}
	defer subMacroDelete.Unsubscribe()
	subMacroExecute, err := nc.QueueSubscribe(SubjectMacroExecute, QueueGroup, s.handleMacroExecute)
	if err != nil {
		return err
	}
	defer subMacroExecute.Unsubscribe()
	cc, err := s.consumeSnoozeWakes(ctx)
	if err != nil {
		return err
	}
	defer cc.Stop()
	if err := s.subscribeP6(nc); err != nil {
		return err
	}
	if err := s.subscribeP9(nc); err != nil {
		return err
	}
	fanout, err := s.consumeWebhookEvents(ctx)
	if err != nil {
		return err
	}
	defer fanout.Stop()
	deliver, err := s.consumeWebhookDeliveries(ctx)
	if err != nil {
		return err
	}
	defer deliver.Stop()
	if err := nc.Flush(); err != nil {
		return err
	}
	<-ctx.Done()
	return ctx.Err()
}

func (s *Service) handleCreate(msg *nats.Msg) {
	var req contracts.ConversationsCreate
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
		AccountID:    accountID,
		InboxID:      inboxID,
		SourceID:     req.SourceID,
		Name:         req.Name,
		TraceID:      req.TraceID,
		ReuseContact: req.ReuseContact,
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
	var req contracts.ConversationsTransition
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
	if req.ActorID != "" {
		id, err := uuid.Parse(req.ActorID)
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

func (s *Service) handleContactAuth(msg *nats.Msg) {
	var req struct {
		InboxID     string `json:"inbox_id"`
		PubsubToken string `json:"pubsub_token"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	inboxID, err := uuid.Parse(req.InboxID)
	if err != nil {
		_ = msg.Respond(rpcErr(ErrUnauthorized))
		return
	}
	out, err := s.AuthContact(context.Background(), ContactAuthInput{InboxID: inboxID, PubsubToken: req.PubsubToken})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	row := map[string]any{
		"ok":               true,
		"account_id":       out.AccountID.String(),
		"inbox_id":         out.InboxID.String(),
		"contact_id":       out.ContactID.String(),
		"contact_inbox_id": out.ContactInboxID.String(),
		"source_id":        out.SourceID,
	}
	if out.ConversationID != uuid.Nil {
		row["conversation_id"] = out.ConversationID.String()
	}
	body, _ := json.Marshal(row)
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

func (s *Service) handleInboxGet(msg *nats.Msg) {
	s.respondInboxHMAC(msg, s.GetInbox)
}

func (s *Service) handleInboxRotateHMAC(msg *nats.Msg) {
	s.respondInboxHMAC(msg, s.RotateHMAC)
}

func (s *Service) respondInboxHMAC(msg *nats.Msg, fn func(context.Context, MemberInput) (InboxHMAC, error)) {
	in, err := parseMemberInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	got, err := fn(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	_ = msg.Respond(inboxHMACBody(got))
}

func inboxHMACBody(got InboxHMAC) []byte {
	hours := got.BusinessHours
	if len(hours) == 0 {
		hours = []byte("{}")
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "id": got.ID.String(), "name": got.Name,
		"channel_type": got.ChannelType, "hmac_secret": got.HMACSecret,
		"greeting_message": got.GreetingMessage, "business_hours_enabled": got.BusinessHoursEnabled,
		"business_hours": json.RawMessage(hours),
	})
	return body
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

func parseListInput(msg *nats.Msg) (ListInput, error) {
	var req struct {
		ActorUserID    string   `json:"actor_user_id"`
		AccountID      string   `json:"account_id"`
		InboxIDs       []string `json:"inbox_ids"`
		ConversationID string   `json:"conversation_id"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return ListInput{}, err
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		return ListInput{}, err
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return ListInput{}, err
	}
	in := ListInput{ActorUserID: actor, AccountID: accountID}
	for _, s := range req.InboxIDs {
		id := parseUUID(s)
		if id != uuid.Nil {
			in.InboxIDs = append(in.InboxIDs, id)
		}
	}
	if req.ConversationID != "" {
		id, err := uuid.Parse(req.ConversationID)
		if err != nil {
			return ListInput{}, err
		}
		in.ConversationID = id
	}
	return in, nil
}

func parseUUID(s string) uuid.UUID {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil
	}
	return id
}

func (s *Service) handleConversationsList(msg *nats.Msg) {
	in, err := parseListInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListConversations(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, c := range list {
		rows = append(rows, EncodeConversationList(c))
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "conversations": rows})
	_ = msg.Respond(body)
}

func (s *Service) handleMessagesList(msg *nats.Msg) {
	in, err := parseListInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListMessages(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, m := range list {
		atts := make([]map[string]any, 0, len(m.Attachments))
		for _, a := range m.Attachments {
			atts = append(atts, map[string]any{
				"id": a.ID.String(), "file_type": a.FileType, "external_url": a.ExternalURL, "file_size": a.FileSize,
			})
		}
		rows = append(rows, map[string]any{
			"id": m.ID.String(), "content": m.Content, "sender_type": m.SenderType,
			"content_type": m.ContentType, "private": m.Private,
			"created_at":  m.CreatedAt.UTC().Format(time.RFC3339Nano),
			"attachments": atts,
		})
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "messages": rows})
	_ = msg.Respond(body)
}

func (s *Service) handleContactsList(msg *nats.Msg) {
	in, err := parseListInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListContacts(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, c := range list {
		rows = append(rows, map[string]any{
			"id": c.ID.String(), "name": c.Name, "email": c.Email, "identifier": c.Identifier,
		})
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "contacts": rows})
	_ = msg.Respond(body)
}

func (s *Service) handleIdentify(msg *nats.Msg) {
	var req struct {
		AccountID      string `json:"account_id"`
		InboxID        string `json:"inbox_id"`
		ContactID      string `json:"contact_id"`
		Identifier     string `json:"identifier"`
		IdentifierHash string `json:"identifier_hash"`
		Name           string `json:"name"`
		Email          string `json:"email"`
	}
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
	contactID, err := uuid.Parse(req.ContactID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.IdentifyContact(context.Background(), IdentifyInput{
		AccountID: accountID, InboxID: inboxID, ContactID: contactID,
		Identifier: req.Identifier, IdentifierHash: req.IdentifierHash,
		Name: req.Name, Email: req.Email,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "contact_id": out.ContactID.String(),
		"identifier": out.Identifier, "name": out.Name, "email": out.Email,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleEmailReply(msg *nats.Msg) {
	var req struct {
		ActorUserID    string `json:"actor_user_id"`
		AccountID      string `json:"account_id"`
		ConversationID string `json:"conversation_id"`
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
	out, skip, err := s.EmailReply(context.Background(), ListInput{
		ActorUserID: actor, AccountID: accountID, ConversationID: convID,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "skip": skip, "from": out.From, "to": out.To,
		"in_reply_to": out.InReplyTo, "display_id": out.DisplayID,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleKakaoReply(msg *nats.Msg) {
	var req struct {
		ActorUserID    string `json:"actor_user_id"`
		AccountID      string `json:"account_id"`
		ConversationID string `json:"conversation_id"`
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
	out, skip, err := s.KakaoReply(context.Background(), ListInput{
		ActorUserID: actor, AccountID: accountID, ConversationID: convID,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "skip": skip, "from": out.From, "to": out.To,
		"session_live": out.SessionLive, "template": out.Template, "phone": out.Phone,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleResolveKakaoInbox(msg *nats.Msg) {
	var req struct {
		SenderKey string `json:"sender_key"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	accountID, inboxID, err := s.ResolveKakaoInbox(context.Background(), req.SenderKey)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "account_id": accountID.String(), "inbox_id": inboxID.String(),
	})
	_ = msg.Respond(body)
}

func (s *Service) handleResolveKakao(msg *nats.Msg) {
	var req struct {
		AccountID string `json:"account_id"`
		InboxID   string `json:"inbox_id"`
		SourceID  string `json:"source_id"`
		UserKey   string `json:"user_key"`
	}
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
	out, found, dup, err := s.ResolveKakao(context.Background(), KakaoInput{
		AccountID: accountID, InboxID: inboxID, MsgKey: req.SourceID, UserKey: req.UserKey,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok":               true,
		"found":            found,
		"duplicate":        dup,
		"contact_id":       out.ContactID.String(),
		"contact_inbox_id": out.ContactInboxID.String(),
		"conversation_id":  out.ConversationID.String(),
		"display_id":       out.DisplayID,
		"status":           out.Status,
		"version":          out.Version,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleResolveInbox(msg *nats.Msg) {
	var req struct {
		Email string `json:"email"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	accountID, inboxID, err := s.ResolveInbox(context.Background(), req.Email)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "account_id": accountID.String(), "inbox_id": inboxID.String(),
	})
	_ = msg.Respond(body)
}

func (s *Service) handleResolveThread(msg *nats.Msg) {
	var req struct {
		AccountID string   `json:"account_id"`
		InboxID   string   `json:"inbox_id"`
		SourceID  string   `json:"source_id"`
		ReplyIDs  []string `json:"reply_ids"`
		DisplayID int64    `json:"display_id"`
	}
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
	out, found, dup, err := s.ResolveThread(context.Background(), ThreadInput{
		AccountID: accountID, InboxID: inboxID, SourceID: req.SourceID,
		ReplyIDs: req.ReplyIDs, DisplayID: req.DisplayID,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok":               true,
		"found":            found,
		"duplicate":        dup,
		"contact_id":       out.ContactID.String(),
		"contact_inbox_id": out.ContactInboxID.String(),
		"conversation_id":  out.ConversationID.String(),
		"display_id":       out.DisplayID,
		"status":           out.Status,
		"version":          out.Version,
	})
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
