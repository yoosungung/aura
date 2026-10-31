package gateway

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

type PlatformOut struct {
	AccountID  uuid.UUID
	UserID     uuid.UUID
	InboxID    uuid.UUID
	HMACSecret string
	Role       string
}

type Platform interface {
	ProvisionAccount(ctx context.Context, name, locale, userName, email, password string) (PlatformOut, error)
	ProvisionUser(ctx context.Context, account uuid.UUID, name, email, password, role string) (PlatformOut, error)
}

type WebhookOut struct {
	ID            uuid.UUID
	URL           string
	Subscriptions []string
	Secret        string
}

type WebhookStore interface {
	ListWebhooks(ctx context.Context, actor, account uuid.UUID) ([]WebhookOut, error)
	CreateWebhook(ctx context.Context, actor, account uuid.UUID, rawURL string, subs []string) (WebhookOut, error)
	DeleteWebhook(ctx context.Context, actor, account, webhook uuid.UUID) error
}

type ReportOut struct {
	Conversations map[string]any
	Agents        []map[string]any
	Inboxes       []map[string]any
	CSATPercent   float64
	SLAHitRate    float64
}

type Reporter interface {
	Report(ctx context.Context, actor, account uuid.UUID) (ReportOut, error)
}

type ArticleOut struct {
	ID        uuid.UUID
	Title     string
	Slug      string
	Body      string
	Published bool
}

type ArticleStore interface {
	ListArticles(ctx context.Context, actor, account uuid.UUID) ([]ArticleOut, error)
	CreateArticle(ctx context.Context, actor, account uuid.UUID, title, slug, body string, published bool) (ArticleOut, error)
	DeleteArticle(ctx context.Context, actor, account, article uuid.UUID) error
	SearchArticles(ctx context.Context, inbox uuid.UUID, query string) ([]ArticleOut, error)
}

type ContactCatalog interface {
	ListContactConversations(ctx context.Context, account, inbox, contact uuid.UUID) ([]ConversationRow, error)
	ListContactMessages(ctx context.Context, account, inbox, contact, conversation uuid.UUID) ([]MessageRow, error)
}

func (s *Server) handlePlatformAccount(w http.ResponseWriter, r *http.Request) {
	if !s.platformOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if s.Service.Platform == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Name   string `json:"name"`
		Locale string `json:"locale"`
		User   struct {
			Name     string `json:"name"`
			Email    string `json:"email"`
			Password string `json:"password"`
		} `json:"user"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	out, err := s.Service.Platform.ProvisionAccount(r.Context(), body.Name, body.Locale, body.User.Name, body.User.Email, body.User.Password)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	writeJSON(w, map[string]any{
		"account_id": out.AccountID.String(), "user_id": out.UserID.String(),
		"inbox_id": out.InboxID.String(), "hmac_secret": out.HMACSecret, "role": out.Role,
	})
}

func (s *Server) handlePlatformUser(w http.ResponseWriter, r *http.Request) {
	if !s.platformOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if s.Service.Platform == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		AccountID string `json:"account_id"`
		Name      string `json:"name"`
		Email     string `json:"email"`
		Password  string `json:"password"`
		Role      string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	accountID, err := uuid.Parse(body.AccountID)
	if err != nil {
		http.Error(w, "invalid account", http.StatusBadRequest)
		return
	}
	out, err := s.Service.Platform.ProvisionUser(r.Context(), accountID, body.Name, body.Email, body.Password, body.Role)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	writeJSON(w, map[string]any{
		"account_id": out.AccountID.String(), "user_id": out.UserID.String(), "role": out.Role,
	})
}

func (s *Server) handleWebhooks(w http.ResponseWriter, r *http.Request) {
	if s.Service.Webhooks == nil {
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
		list, err := s.Service.Webhooks.ListWebhooks(r.Context(), tok.UserID, accountID)
		if err != nil {
			writeCatalogErr(w, err)
			return
		}
		rows := make([]map[string]any, 0, len(list))
		for _, h := range list {
			rows = append(rows, encodeWebhookHTTP(h))
		}
		writeJSON(w, map[string]any{"webhooks": rows})
	case http.MethodPost:
		var body struct {
			URL           string   `json:"url"`
			Subscriptions []string `json:"subscriptions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		got, err := s.Service.Webhooks.CreateWebhook(r.Context(), tok.UserID, accountID, body.URL, body.Subscriptions)
		if err != nil {
			writeCatalogErr(w, err)
			return
		}
		writeJSON(w, encodeWebhookHTTP(got))
	case http.MethodDelete:
		id, err := uuid.Parse(r.PathValue("webhook_id"))
		if err != nil {
			http.Error(w, "invalid webhook", http.StatusBadRequest)
			return
		}
		if err := s.Service.Webhooks.DeleteWebhook(r.Context(), tok.UserID, accountID, id); err != nil {
			writeCatalogErr(w, err)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleReports(w http.ResponseWriter, r *http.Request) {
	if s.Service.Reports == nil {
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
	out, err := s.Service.Reports.Report(r.Context(), tok.UserID, accountID)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	writeJSON(w, map[string]any{
		"conversations": out.Conversations, "agents": out.Agents, "inboxes": out.Inboxes,
		"csat_percent": out.CSATPercent, "sla_hit_rate": out.SLAHitRate,
	})
}

func (s *Server) handleArticles(w http.ResponseWriter, r *http.Request) {
	if s.Service.Articles == nil {
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
		list, err := s.Service.Articles.ListArticles(r.Context(), tok.UserID, accountID)
		if err != nil {
			writeCatalogErr(w, err)
			return
		}
		writeJSON(w, map[string]any{"articles": encodeArticlesHTTP(list)})
	case http.MethodPost:
		var body struct {
			Title     string `json:"title"`
			Slug      string `json:"slug"`
			Body      string `json:"body"`
			Published bool   `json:"published"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		got, err := s.Service.Articles.CreateArticle(r.Context(), tok.UserID, accountID, body.Title, body.Slug, body.Body, body.Published)
		if err != nil {
			writeCatalogErr(w, err)
			return
		}
		writeJSON(w, encodeArticleHTTP(got))
	case http.MethodDelete:
		id, err := uuid.Parse(r.PathValue("article_id"))
		if err != nil {
			http.Error(w, "invalid article", http.StatusBadRequest)
			return
		}
		if err := s.Service.Articles.DeleteArticle(r.Context(), tok.UserID, accountID, id); err != nil {
			writeCatalogErr(w, err)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handlePublicArticles(w http.ResponseWriter, r *http.Request) {
	if s.Service.Articles == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	inboxID, err := uuid.Parse(r.PathValue("inbox_id"))
	if err != nil {
		http.Error(w, "invalid inbox", http.StatusBadRequest)
		return
	}
	list, err := s.Service.Articles.SearchArticles(r.Context(), inboxID, r.URL.Query().Get("q"))
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	writeJSON(w, map[string]any{"articles": encodeArticlesHTTP(list)})
}

func (s *Server) handleContactConversations(w http.ResponseWriter, r *http.Request) {
	tok, inboxID, contactID, ok := s.contactPath(w, r)
	if !ok {
		return
	}
	if s.Service.ContactAPI == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	list, err := s.Service.ContactAPI.ListContactConversations(r.Context(), tok.AccountID, inboxID, contactID)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, c := range list {
		rows = append(rows, map[string]any{
			"id": c.ID.String(), "inbox_id": c.InboxID.String(), "contact_id": c.ContactID.String(),
			"contact_inbox_id": c.ContactInboxID.String(), "status": c.Status, "display_id": c.DisplayID,
			"last_content": c.LastContent,
		})
	}
	writeJSON(w, map[string]any{"conversations": rows})
}

func (s *Server) handleContactMessages(w http.ResponseWriter, r *http.Request) {
	tok, inboxID, contactID, ok := s.contactPath(w, r)
	if !ok {
		return
	}
	conversationID, err := uuid.Parse(r.PathValue("conversation_id"))
	if err != nil {
		http.Error(w, "invalid conversation", http.StatusBadRequest)
		return
	}
	if s.Service.ContactAPI == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	list, err := s.Service.ContactAPI.ListContactMessages(r.Context(), tok.AccountID, inboxID, contactID, conversationID)
	if err != nil {
		writeCatalogErr(w, err)
		return
	}
	rows := make([]map[string]any, 0, len(list))
	for _, m := range list {
		rows = append(rows, map[string]any{
			"id": m.ID.String(), "content": m.Content, "sender_type": m.SenderType, "created_at": m.CreatedAt,
		})
	}
	writeJSON(w, map[string]any{"messages": rows})
}

func (s *Server) contactPath(w http.ResponseWriter, r *http.Request) (Token, uuid.UUID, uuid.UUID, bool) {
	tok, err := s.bearer(r)
	if err != nil || tok.Kind != KindContact {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return Token{}, uuid.Nil, uuid.Nil, false
	}
	inboxID, err := uuid.Parse(r.PathValue("inbox_id"))
	if err != nil || inboxID != tok.InboxID {
		http.Error(w, "forbidden", http.StatusForbidden)
		return Token{}, uuid.Nil, uuid.Nil, false
	}
	contactID, err := uuid.Parse(r.PathValue("contact_id"))
	if err != nil || contactID != tok.ContactID {
		http.Error(w, "forbidden", http.StatusForbidden)
		return Token{}, uuid.Nil, uuid.Nil, false
	}
	return tok, inboxID, contactID, true
}

func (s *Server) platformOK(r *http.Request) bool {
	if s.PlatformToken == "" {
		return false
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.PlatformToken)) != 1 {
		return false
	}
	return true
}

func encodeWebhookHTTP(h WebhookOut) map[string]any {
	return map[string]any{"id": h.ID.String(), "url": h.URL, "subscriptions": h.Subscriptions, "secret": h.Secret}
}

func encodeArticleHTTP(a ArticleOut) map[string]any {
	return map[string]any{"id": a.ID.String(), "title": a.Title, "slug": a.Slug, "body": a.Body, "published": a.Published}
}

func encodeArticlesHTTP(list []ArticleOut) []map[string]any {
	rows := make([]map[string]any, 0, len(list))
	for _, a := range list {
		rows = append(rows, encodeArticleHTTP(a))
	}
	return rows
}

func (r *natsRPC) ProvisionAccount(ctx context.Context, name, locale, userName, email, password string) (PlatformOut, error) {
	raw, err := r.call(ctx, core.SubjectPlatformAccount, map[string]any{
		"name": name, "locale": locale,
		"user": map[string]any{"name": userName, "email": email, "password": password},
	})
	if err != nil {
		return PlatformOut{}, err
	}
	return PlatformOut{
		AccountID: parseUUID(asString(raw["account_id"])), UserID: parseUUID(asString(raw["user_id"])),
		InboxID: parseUUID(asString(raw["inbox_id"])), HMACSecret: asString(raw["hmac_secret"]), Role: asString(raw["role"]),
	}, nil
}

func (r *natsRPC) ProvisionUser(ctx context.Context, account uuid.UUID, name, email, password, role string) (PlatformOut, error) {
	raw, err := r.call(ctx, core.SubjectPlatformUser, map[string]any{
		"account_id": account.String(), "name": name, "email": email, "password": password, "role": role,
	})
	if err != nil {
		return PlatformOut{}, err
	}
	return PlatformOut{
		AccountID: parseUUID(asString(raw["account_id"])), UserID: parseUUID(asString(raw["user_id"])), Role: asString(raw["role"]),
	}, nil
}

func (r *natsRPC) ListWebhooks(ctx context.Context, actor, account uuid.UUID) ([]WebhookOut, error) {
	raw, err := r.call(ctx, core.SubjectWebhookList, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
	})
	if err != nil {
		return nil, err
	}
	return decodeWebhooks(raw["webhooks"])
}

func (r *natsRPC) CreateWebhook(ctx context.Context, actor, account uuid.UUID, rawURL string, subs []string) (WebhookOut, error) {
	raw, err := r.call(ctx, core.SubjectWebhookCreate, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "url": rawURL, "subscriptions": subs,
	})
	if err != nil {
		return WebhookOut{}, err
	}
	hook, _ := raw["webhook"].(map[string]any)
	return decodeWebhook(hook), nil
}

func (r *natsRPC) DeleteWebhook(ctx context.Context, actor, account, webhook uuid.UUID) error {
	_, err := r.call(ctx, core.SubjectWebhookDelete, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "webhook_id": webhook.String(),
	})
	return err
}

func (r *natsRPC) Report(ctx context.Context, actor, account uuid.UUID) (ReportOut, error) {
	raw, err := r.call(ctx, core.SubjectReportsGet, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
	})
	if err != nil {
		return ReportOut{}, err
	}
	out := ReportOut{CSATPercent: asFloat(raw["csat_percent"]), SLAHitRate: asFloat(raw["sla_hit_rate"])}
	if m, ok := raw["conversations"].(map[string]any); ok {
		out.Conversations = m
	}
	out.Agents = asMapSlice(raw["agents"])
	out.Inboxes = asMapSlice(raw["inboxes"])
	return out, nil
}

func (r *natsRPC) ListArticles(ctx context.Context, actor, account uuid.UUID) ([]ArticleOut, error) {
	raw, err := r.call(ctx, core.SubjectArticleList, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
	})
	if err != nil {
		return nil, err
	}
	return decodeArticles(raw["articles"])
}

func (r *natsRPC) CreateArticle(ctx context.Context, actor, account uuid.UUID, title, slug, body string, published bool) (ArticleOut, error) {
	raw, err := r.call(ctx, core.SubjectArticleCreate, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(),
		"title": title, "slug": slug, "body": body, "published": published,
	})
	if err != nil {
		return ArticleOut{}, err
	}
	art, _ := raw["article"].(map[string]any)
	return decodeArticle(art), nil
}

func (r *natsRPC) DeleteArticle(ctx context.Context, actor, account, article uuid.UUID) error {
	_, err := r.call(ctx, core.SubjectArticleDelete, map[string]any{
		"actor_user_id": actor.String(), "account_id": account.String(), "article_id": article.String(),
	})
	return err
}

func (r *natsRPC) SearchArticles(ctx context.Context, inbox uuid.UUID, query string) ([]ArticleOut, error) {
	raw, err := r.call(ctx, core.SubjectArticleSearch, map[string]any{
		"inbox_id": inbox.String(), "query": query,
	})
	if err != nil {
		return nil, err
	}
	return decodeArticles(raw["articles"])
}

func (r *natsRPC) ListContactConversations(ctx context.Context, account, inbox, contact uuid.UUID) ([]ConversationRow, error) {
	raw, err := r.call(ctx, core.SubjectContactConversations, map[string]any{
		"account_id": account.String(), "inbox_id": inbox.String(), "contact_id": contact.String(),
	})
	if err != nil {
		return nil, err
	}
	return decodeContactConversations(raw["conversations"])
}

func (r *natsRPC) ListContactMessages(ctx context.Context, account, inbox, contact, conversation uuid.UUID) ([]MessageRow, error) {
	raw, err := r.call(ctx, core.SubjectContactMessages, map[string]any{
		"account_id": account.String(), "inbox_id": inbox.String(),
		"contact_id": contact.String(), "conversation_id": conversation.String(),
	})
	if err != nil {
		return nil, err
	}
	return decodeContactMessages(raw["messages"])
}

func (r *natsRPC) call(ctx context.Context, subject string, payload any) (map[string]any, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	msg, err := r.nc.RequestWithContext(ctx, subject, body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return nil, err
	}
	if ok, _ := out["ok"].(bool); !ok {
		errText, _ := out["error"].(string)
		if errText == "" {
			errText = "rpc_failed"
		}
		return nil, fmt.Errorf("%s", errText)
	}
	return out, nil
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func asFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}

func asMapSlice(v any) []map[string]any {
	raw, _ := v.([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func decodeWebhook(m map[string]any) WebhookOut {
	var subs []string
	if raw, ok := m["subscriptions"].([]any); ok {
		for _, s := range raw {
			if str, ok := s.(string); ok {
				subs = append(subs, str)
			}
		}
	}
	return WebhookOut{ID: parseUUID(asString(m["id"])), URL: asString(m["url"]), Subscriptions: subs, Secret: asString(m["secret"])}
}

func decodeWebhooks(v any) ([]WebhookOut, error) {
	raw, _ := v.([]any)
	out := make([]WebhookOut, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, decodeWebhook(m))
		}
	}
	return out, nil
}

func decodeArticle(m map[string]any) ArticleOut {
	pub, _ := m["published"].(bool)
	return ArticleOut{
		ID: parseUUID(asString(m["id"])), Title: asString(m["title"]), Slug: asString(m["slug"]),
		Body: asString(m["body"]), Published: pub,
	}
}

func decodeArticles(v any) ([]ArticleOut, error) {
	raw, _ := v.([]any)
	out := make([]ArticleOut, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, decodeArticle(m))
		}
	}
	return out, nil
}

func decodeContactConversations(v any) ([]ConversationRow, error) {
	raw, _ := v.([]any)
	out := make([]ConversationRow, 0, len(raw))
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, ConversationRow{
			ID: parseUUID(asString(m["id"])), InboxID: parseUUID(asString(m["inbox_id"])),
			ContactID: parseUUID(asString(m["contact_id"])), ContactInboxID: parseUUID(asString(m["contact_inbox_id"])),
			Status: asString(m["status"]), LastContent: asString(m["last_content"]),
			DisplayID: int64(asFloat(m["display_id"])),
		})
	}
	return out, nil
}

func decodeContactMessages(v any) ([]MessageRow, error) {
	raw, _ := v.([]any)
	out := make([]MessageRow, 0, len(raw))
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, MessageRow{
			ID: parseUUID(asString(m["id"])), Content: asString(m["content"]),
			SenderType: asString(m["sender_type"]), CreatedAt: asString(m["created_at"]),
		})
	}
	return out, nil
}
