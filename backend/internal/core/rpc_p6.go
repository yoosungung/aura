package core

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
)

func (s *Service) subscribeP6(nc *nats.Conn) error {
	type sub struct {
		subject string
		handler nats.MsgHandler
	}
	subs := []sub{
		{SubjectPlatformAccount, s.handlePlatformAccount},
		{SubjectPlatformAccountList, s.handlePlatformAccountList},
		{SubjectPlatformAccountUpdate, s.handlePlatformAccountUpdate},
		{SubjectPlatformAccountDelete, s.handlePlatformAccountDelete},
		{SubjectPlatformUser, s.handlePlatformUser},
		{SubjectPlatformUserList, s.handlePlatformUserList},
		{SubjectPlatformUserUpdate, s.handlePlatformUserUpdate},
		{SubjectPlatformUserDelete, s.handlePlatformUserDelete},
		{SubjectWebhookList, s.handleWebhookList},
		{SubjectWebhookCreate, s.handleWebhookCreate},
		{SubjectWebhookUpdate, s.handleWebhookUpdate},
		{SubjectWebhookDelete, s.handleWebhookDelete},
		{SubjectReportsGet, s.handleReportsGet},
		{SubjectArticleList, s.handleArticleList},
		{SubjectArticleCreate, s.handleArticleCreate},
		{SubjectArticleUpdate, s.handleArticleUpdate},
		{SubjectArticleDelete, s.handleArticleDelete},
		{SubjectArticleSearch, s.handleArticleSearch},
		{SubjectContactConversations, s.handleContactConversations},
		{SubjectContactMessages, s.handleContactMessages},
		{SubjectOntologyEgo, s.handleOntologyEgo},
		{SubjectToolsApprove, s.handleToolsApprove},
		{SubjectContactPurge, s.handleContactPurge},
		{SubjectMCPList, s.handleMCPList},
		{SubjectMCPUpsert, s.handleMCPUpsert},
		{SubjectMCPDelete, s.handleMCPDelete},
		{SubjectMCPRotate, s.handleMCPRotate},
		{SubjectAgentSkillList, s.handleAgentSkillList},
		{SubjectAgentSkillUpsert, s.handleAgentSkillUpsert},
		{SubjectAgentSkillDelete, s.handleAgentSkillDelete},
	}
	for _, item := range subs {
		if _, err := nc.QueueSubscribe(item.subject, QueueGroup, item.handler); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) handlePlatformAccount(msg *nats.Msg) {
	var req struct {
		Name   string `json:"name"`
		Locale string `json:"locale"`
		User   struct {
			Name     string `json:"name"`
			Email    string `json:"email"`
			Password string `json:"password"`
		} `json:"user"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.ProvisionAccount(context.Background(), ProvisionAccountInput{
		Name: req.Name, Locale: req.Locale,
		User: ProvisionUserInput{Name: req.User.Name, Email: req.User.Email, Password: req.User.Password},
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "account_id": out.AccountID.String(), "user_id": out.UserID.String(),
		"inbox_id": out.InboxID.String(), "hmac_secret": out.HMACSecret, "role": out.Role,
	})
	_ = msg.Respond(body)
}

func (s *Service) handlePlatformUser(msg *nats.Msg) {
	var req struct {
		AccountID string `json:"account_id"`
		Name      string `json:"name"`
		Email     string `json:"email"`
		Password  string `json:"password"`
		Role      string `json:"role"`
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
	out, err := s.ProvisionUser(context.Background(), ProvisionUserInput{
		AccountID: accountID, Name: req.Name, Email: req.Email, Password: req.Password, Role: req.Role,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "account_id": out.AccountID.String(), "user_id": out.UserID.String(), "role": out.Role,
	})
	_ = msg.Respond(body)
}

func (s *Service) handlePlatformAccountList(msg *nats.Msg) {
	list, err := s.ListAccounts(context.Background())
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, a := range list {
		rows = append(rows, map[string]any{"id": a.ID.String(), "name": a.Name, "locale": a.Locale})
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "accounts": rows})
	_ = msg.Respond(body)
}

func (s *Service) handlePlatformAccountUpdate(msg *nats.Msg) {
	var req struct {
		AccountID string `json:"account_id"`
		Name      string `json:"name"`
		Locale    string `json:"locale"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	id, err := uuid.Parse(req.AccountID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.UpdateAccount(context.Background(), id, req.Name, req.Locale)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "account": map[string]any{"id": out.ID.String(), "name": out.Name, "locale": out.Locale},
	})
	_ = msg.Respond(body)
}

func (s *Service) handlePlatformAccountDelete(msg *nats.Msg) {
	var req struct {
		AccountID string `json:"account_id"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	id, err := uuid.Parse(req.AccountID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.DeleteAccount(context.Background(), id); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func (s *Service) handlePlatformUserList(msg *nats.Msg) {
	var req struct {
		AccountID string `json:"account_id"`
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
	list, err := s.ListUsers(context.Background(), accountID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, u := range list {
		rows = append(rows, map[string]any{
			"id": u.ID.String(), "account_id": u.AccountID.String(),
			"name": u.Name, "email": u.Email, "role": u.Role,
		})
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "users": rows})
	_ = msg.Respond(body)
}

func (s *Service) handlePlatformUserUpdate(msg *nats.Msg) {
	var req struct {
		UserID    string `json:"user_id"`
		AccountID string `json:"account_id"`
		Name      string `json:"name"`
		Email     string `json:"email"`
		Password  string `json:"password"`
		Role      string `json:"role"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	id, err := uuid.Parse(req.UserID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.UpdateUser(context.Background(), UpdateUserInput{
		ID: id, AccountID: parseUUID(req.AccountID), Name: req.Name,
		Email: req.Email, Password: req.Password, Role: req.Role,
	})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	user := map[string]any{"id": out.ID.String(), "name": out.Name, "email": out.Email, "role": out.Role}
	if out.AccountID != uuid.Nil {
		user["account_id"] = out.AccountID.String()
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "user": user})
	_ = msg.Respond(body)
}

func (s *Service) handlePlatformUserDelete(msg *nats.Msg) {
	var req struct {
		UserID string `json:"user_id"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	id, err := uuid.Parse(req.UserID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.DeleteUser(context.Background(), id); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func (s *Service) handleWebhookList(msg *nats.Msg) {
	in, err := parseWebhookInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListWebhooks(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, w := range list {
		rows = append(rows, encodeWebhook(w))
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "webhooks": rows})
	_ = msg.Respond(body)
}

func (s *Service) handleWebhookCreate(msg *nats.Msg) {
	in, err := parseWebhookInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.CreateWebhook(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	_ = msg.Respond(webhookJSON(out))
}

func (s *Service) handleWebhookUpdate(msg *nats.Msg) {
	in, err := parseWebhookInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.UpdateWebhook(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	_ = msg.Respond(webhookJSON(out))
}

func (s *Service) handleWebhookDelete(msg *nats.Msg) {
	in, err := parseWebhookInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.DeleteWebhook(context.Background(), in); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func (s *Service) handleReportsGet(msg *nats.Msg) {
	in, err := parseWebhookInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.Report(context.Background(), ReportInput{ActorUserID: in.ActorUserID, AccountID: in.AccountID})
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	agents := make([]map[string]any, 0, len(out.Agents))
	for _, a := range out.Agents {
		agents = append(agents, map[string]any{
			"user_id": a.UserID.String(), "name": a.Name,
			"open_count": a.OpenCount, "resolved_count": a.ResolvedCount,
		})
	}
	inboxes := make([]map[string]any, 0, len(out.Inboxes))
	for _, i := range out.Inboxes {
		inboxes = append(inboxes, map[string]any{
			"inbox_id": i.InboxID.String(), "name": i.Name, "conversation_count": i.ConversationCount,
		})
	}
	body, _ := json.Marshal(map[string]any{
		"ok": true, "conversations": out.Conversations, "agents": agents, "inboxes": inboxes,
		"csat_percent": out.CSATPercent, "sla_hit_rate": out.SLAHitRate,
	})
	_ = msg.Respond(body)
}

func (s *Service) handleArticleList(msg *nats.Msg) {
	in, err := parseArticleInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListArticles(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	_ = msg.Respond(articlesJSON(list))
}

func (s *Service) handleArticleCreate(msg *nats.Msg) {
	in, err := parseArticleInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.CreateArticle(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "article": encodeArticle(out)})
	_ = msg.Respond(body)
}

func (s *Service) handleArticleUpdate(msg *nats.Msg) {
	in, err := parseArticleInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	out, err := s.UpdateArticle(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "article": encodeArticle(out)})
	_ = msg.Respond(body)
}

func (s *Service) handleArticleDelete(msg *nats.Msg) {
	in, err := parseArticleInput(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	if err := s.DeleteArticle(context.Background(), in); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	body, _ := json.Marshal(map[string]any{"ok": true})
	_ = msg.Respond(body)
}

func (s *Service) handleArticleSearch(msg *nats.Msg) {
	var req struct {
		InboxID string `json:"inbox_id"`
		Query   string `json:"query"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	inboxID, err := uuid.Parse(req.InboxID)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.SearchArticles(context.Background(), inboxID, req.Query)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	_ = msg.Respond(articlesJSON(list))
}

func (s *Service) handleContactConversations(msg *nats.Msg) {
	in, err := parseContactScope(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListContactConversations(context.Background(), in)
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

func (s *Service) handleContactMessages(msg *nats.Msg) {
	in, err := parseContactScope(msg)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	list, err := s.ListContactMessages(context.Background(), in)
	if err != nil {
		_ = msg.Respond(rpcErr(err))
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, m := range list {
		rows = append(rows, map[string]any{
			"id": m.ID.String(), "content": m.Content, "sender_type": m.SenderType,
			"private": m.Private, "created_at": m.CreatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "messages": rows})
	_ = msg.Respond(body)
}

func parseWebhookInput(msg *nats.Msg) (WebhookInput, error) {
	var req struct {
		ActorUserID   string   `json:"actor_user_id"`
		AccountID     string   `json:"account_id"`
		WebhookID     string   `json:"webhook_id"`
		URL           string   `json:"url"`
		Subscriptions []string `json:"subscriptions"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return WebhookInput{}, err
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		return WebhookInput{}, err
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return WebhookInput{}, err
	}
	return WebhookInput{
		ActorUserID: actor, AccountID: accountID, WebhookID: parseUUID(req.WebhookID),
		URL: req.URL, Subscriptions: req.Subscriptions,
	}, nil
}

func parseArticleInput(msg *nats.Msg) (ArticleInput, error) {
	var req struct {
		ActorUserID string `json:"actor_user_id"`
		AccountID   string `json:"account_id"`
		ArticleID   string `json:"article_id"`
		Title       string `json:"title"`
		Slug        string `json:"slug"`
		Body        string `json:"body"`
		Published   bool   `json:"published"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return ArticleInput{}, err
	}
	actor, err := uuid.Parse(req.ActorUserID)
	if err != nil {
		return ArticleInput{}, err
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return ArticleInput{}, err
	}
	return ArticleInput{
		ActorUserID: actor, AccountID: accountID, ArticleID: parseUUID(req.ArticleID),
		Title: req.Title, Slug: req.Slug, Body: req.Body, Published: req.Published,
	}, nil
}

func parseContactScope(msg *nats.Msg) (ContactScope, error) {
	var req struct {
		AccountID      string `json:"account_id"`
		InboxID        string `json:"inbox_id"`
		ContactID      string `json:"contact_id"`
		ConversationID string `json:"conversation_id"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		return ContactScope{}, err
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return ContactScope{}, err
	}
	inboxID, err := uuid.Parse(req.InboxID)
	if err != nil {
		return ContactScope{}, err
	}
	contactID, err := uuid.Parse(req.ContactID)
	if err != nil {
		return ContactScope{}, err
	}
	return ContactScope{
		AccountID: accountID, InboxID: inboxID, ContactID: contactID,
		ConversationID: parseUUID(req.ConversationID),
	}, nil
}

func encodeArticle(a Article) map[string]any {
	return map[string]any{
		"id": a.ID.String(), "title": a.Title, "slug": a.Slug, "body": a.Body, "published": a.Published,
	}
}

func articlesJSON(list []Article) []byte {
	rows := make([]map[string]any, 0, len(list))
	for _, a := range list {
		rows = append(rows, encodeArticle(a))
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "articles": rows})
	return body
}
