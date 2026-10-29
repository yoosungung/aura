package gateway_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/gateway"
)

type fakeCatalog struct {
	conversations []gateway.ConversationRow
	messages      []gateway.MessageRow
	contacts      []gateway.ContactRow
	status        gateway.TransitionOut
	err           error
}

func (f *fakeCatalog) ListConversations(context.Context, uuid.UUID, uuid.UUID, []uuid.UUID) ([]gateway.ConversationRow, error) {
	return f.conversations, f.err
}
func (f *fakeCatalog) ListMessages(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) ([]gateway.MessageRow, error) {
	return f.messages, f.err
}
func (f *fakeCatalog) ListContacts(context.Context, uuid.UUID, uuid.UUID, []uuid.UUID) ([]gateway.ContactRow, error) {
	return f.contacts, f.err
}
func (f *fakeCatalog) Transition(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, string, int) (gateway.TransitionOut, error) {
	return f.status, f.err
}

func TestHTTP_ListConversationsAndContacts(t *testing.T) {
	accountID, actorID, convID := mustV7(t), mustV7(t), mustV7(t)
	cat := &fakeCatalog{
		conversations: []gateway.ConversationRow{{ID: convID, LastContent: "결제 오류", Status: "unassigned", Version: 1}},
		contacts:      []gateway.ContactRow{{ID: mustV7(t), Name: "Ada"}},
	}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Catalog: cat},
	}).Handler())
	t.Cleanup(srv.Close)
	tok := userToken(t, accountID, actorID)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var body struct {
		Conversations []struct {
			ID          string `json:"id"`
			LastContent string `json:"last_content"`
		} `json:"conversations"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Conversations) != 1 || body.Conversations[0].LastContent != "결제 오류" {
		t.Fatalf("%+v", body)
	}

	req, err = http.NewRequest(http.MethodGet, srv.URL+"/api/v1/accounts/"+accountID.String()+"/contacts", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("contacts %d", res.StatusCode)
	}
}

func TestHTTP_ListMessagesAndResolve(t *testing.T) {
	accountID, actorID, convID := mustV7(t), mustV7(t), mustV7(t)
	cat := &fakeCatalog{
		messages: []gateway.MessageRow{{ID: mustV7(t), Content: "결제 오류", SenderType: "Contact"}},
		status:   gateway.TransitionOut{Status: "resolved", Version: 2},
	}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Catalog: cat},
	}).Handler())
	t.Cleanup(srv.Close)
	tok := userToken(t, accountID, actorID)

	req, err := http.NewRequest(http.MethodGet,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/messages", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("messages %d", res.StatusCode)
	}

	req, err = http.NewRequest(http.MethodPut,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/status",
		strings.NewReader(`{"new_status":"resolved","expected_version":1}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestHTTP_ResolveDenied(t *testing.T) {
	accountID, actorID, convID := mustV7(t), mustV7(t), mustV7(t)
	cat := &fakeCatalog{err: core.ErrDenied}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Catalog: cat},
	}).Handler())
	t.Cleanup(srv.Close)
	req, err := http.NewRequest(http.MethodPut,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/status",
		strings.NewReader(`{"new_status":"resolved","expected_version":1}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+userToken(t, accountID, actorID))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", res.StatusCode)
	}
}
