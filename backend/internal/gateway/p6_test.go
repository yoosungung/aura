package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/gateway"
)

type fakePlatform struct {
	out gateway.PlatformOut
	err error
}

func (f *fakePlatform) ProvisionAccount(context.Context, string, string, string, string, string) (gateway.PlatformOut, error) {
	return f.out, f.err
}
func (f *fakePlatform) ProvisionUser(context.Context, uuid.UUID, string, string, string, string) (gateway.PlatformOut, error) {
	return f.out, f.err
}

type fakeWebhooks struct {
	list []gateway.WebhookOut
	got  gateway.WebhookOut
	err  error
}

func (f *fakeWebhooks) ListWebhooks(context.Context, uuid.UUID, uuid.UUID) ([]gateway.WebhookOut, error) {
	return f.list, f.err
}
func (f *fakeWebhooks) CreateWebhook(context.Context, uuid.UUID, uuid.UUID, string, []string) (gateway.WebhookOut, error) {
	return f.got, f.err
}
func (f *fakeWebhooks) DeleteWebhook(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return f.err
}

type fakeReports struct {
	out gateway.ReportOut
	err error
}

func (f *fakeReports) Report(context.Context, uuid.UUID, uuid.UUID) (gateway.ReportOut, error) {
	return f.out, f.err
}

type fakeArticles struct {
	list []gateway.ArticleOut
	err  error
}

func (f *fakeArticles) ListArticles(context.Context, uuid.UUID, uuid.UUID) ([]gateway.ArticleOut, error) {
	return f.list, f.err
}
func (f *fakeArticles) CreateArticle(context.Context, uuid.UUID, uuid.UUID, string, string, string, bool) (gateway.ArticleOut, error) {
	if len(f.list) > 0 {
		return f.list[0], f.err
	}
	return gateway.ArticleOut{}, f.err
}
func (f *fakeArticles) SearchArticles(context.Context, uuid.UUID, string) ([]gateway.ArticleOut, error) {
	return f.list, f.err
}

type fakeContactAPI struct {
	conversations []gateway.ConversationRow
	messages      []gateway.MessageRow
	err           error
}

func (f *fakeContactAPI) ListContactConversations(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) ([]gateway.ConversationRow, error) {
	return f.conversations, f.err
}
func (f *fakeContactAPI) ListContactMessages(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) ([]gateway.MessageRow, error) {
	return f.messages, f.err
}

func TestHTTP_PlatformAccountRequiresToken(t *testing.T) {
	accountID := mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		PlatformToken: "plat",
		Service: &gateway.Service{Platform: &fakePlatform{out: gateway.PlatformOut{
			AccountID: accountID, UserID: mustV7(t), InboxID: mustV7(t), HMACSecret: "s", Role: "administrator",
		}}},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]any{
		"name": "Acme", "user": map[string]string{"name": "Ada", "email": "ada@acme.test", "password": "s3cret-pass"},
	})
	res, err := http.Post(srv.URL+"/platform/api/v1/accounts", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", res.StatusCode)
	}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/platform/api/v1/accounts", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer plat")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestHTTP_ReportsForbiddenForUnavailable(t *testing.T) {
	accountID, actorID := mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Reports: &fakeReports{err: core.ErrDenied}},
	}).Handler())
	t.Cleanup(srv.Close)
	tok := userToken(t, accountID, actorID)
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/accounts/"+accountID.String()+"/reports", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestHTTP_ContactConversationsScoped(t *testing.T) {
	accountID, inboxID, contactID, convID := mustV7(t), mustV7(t), mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{
			Secret: secret,
			ContactAPI: &fakeContactAPI{conversations: []gateway.ConversationRow{{
				ID: convID, InboxID: inboxID, ContactID: contactID, LastContent: "hi",
			}}},
		},
	}).Handler())
	t.Cleanup(srv.Close)
	tok, err := gateway.Sign(secret, gateway.Token{
		Kind: gateway.KindContact, AccountID: accountID, InboxID: inboxID, ContactID: contactID,
	})
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/public/api/v1/inboxes/"+inboxID.String()+"/contacts/"+contactID.String()+"/conversations", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestHTTP_PublicArticleSearch(t *testing.T) {
	inboxID := mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Articles: &fakeArticles{list: []gateway.ArticleOut{{
			ID: mustV7(t), Title: "결제", Slug: "pay", Body: "한도", Published: true,
		}}}},
	}).Handler())
	t.Cleanup(srv.Close)
	res, err := http.Get(srv.URL + "/public/api/v1/inboxes/" + inboxID.String() + "/articles?q=%EA%B2%B0%EC%A0%9C")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestHTTP_CreateWebhook(t *testing.T) {
	accountID, actorID := mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Webhooks: &fakeWebhooks{got: gateway.WebhookOut{
			ID: mustV7(t), URL: "https://crm.example/hook", Subscriptions: []string{"message_created"}, Secret: "sec",
		}}},
	}).Handler())
	t.Cleanup(srv.Close)
	tok := userToken(t, accountID, actorID)
	body, _ := json.Marshal(map[string]any{"url": "https://crm.example/hook", "subscriptions": []string{"message_created"}})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/accounts/"+accountID.String()+"/webhooks", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
}
