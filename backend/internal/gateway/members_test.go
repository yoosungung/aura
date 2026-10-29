package gateway_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/gateway"
)

type fakeMembers struct {
	added   []uuid.UUID
	addErr  error
	list    []gateway.MemberRow
	listErr error
}

func (f *fakeMembers) AddInboxMember(_ context.Context, _, _, _, user uuid.UUID) error {
	f.added = append(f.added, user)
	return f.addErr
}
func (f *fakeMembers) RemoveInboxMember(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return nil
}
func (f *fakeMembers) ListInboxMembers(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) ([]gateway.MemberRow, error) {
	return f.list, f.listErr
}

func userToken(t *testing.T, accountID, userID uuid.UUID) string {
	t.Helper()
	return mustSign(t, gateway.Token{
		Kind: gateway.KindUser, AccountID: accountID, UserID: userID, Sid: mustV7(t),
	})
}

func TestHTTP_AdminAddsInboxMember(t *testing.T) {
	accountID, actorID, inboxID, agentID := mustV7(t), mustV7(t), mustV7(t), mustV7(t)
	mem := &fakeMembers{}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Members: mem},
	}).Handler())
	t.Cleanup(srv.Close)

	req, err := http.NewRequest(http.MethodPut,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/inboxes/"+inboxID.String()+"/members/"+agentID.String(),
		nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+userToken(t, accountID, actorID))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", res.StatusCode)
	}
	if len(mem.added) != 1 || mem.added[0] != agentID {
		t.Fatalf("added %+v", mem.added)
	}
}

func TestHTTP_AgentDeniedAdd(t *testing.T) {
	accountID, actorID, inboxID, agentID := mustV7(t), mustV7(t), mustV7(t), mustV7(t)
	mem := &fakeMembers{addErr: core.ErrDenied}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Members: mem},
	}).Handler())
	t.Cleanup(srv.Close)
	req, err := http.NewRequest(http.MethodPut,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/inboxes/"+inboxID.String()+"/members/"+agentID.String(),
		nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+userToken(t, accountID, actorID))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestHTTP_ListInboxMembers(t *testing.T) {
	accountID, actorID, inboxID, agentID := mustV7(t), mustV7(t), mustV7(t), mustV7(t)
	mem := &fakeMembers{list: []gateway.MemberRow{{UserID: agentID, Email: "ada@acme.test", Name: "Ada"}}}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Members: mem},
	}).Handler())
	t.Cleanup(srv.Close)
	req, err := http.NewRequest(http.MethodGet,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/inboxes/"+inboxID.String()+"/members",
		nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+userToken(t, accountID, actorID))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var got struct {
		Members []struct {
			UserID string `json:"user_id"`
			Email  string `json:"email"`
		} `json:"members"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Members) != 1 || got.Members[0].UserID != agentID.String() {
		t.Fatalf("%+v", got)
	}
}
