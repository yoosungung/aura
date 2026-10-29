package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/gateway"
)

type fakeAuth struct {
	out gateway.AuthOut
	err error
}

func (f *fakeAuth) Login(context.Context, string, string) (gateway.AuthOut, error) {
	return f.out, f.err
}
func (f *fakeAuth) Refresh(context.Context, string) (gateway.AuthOut, error) {
	return f.out, f.err
}
func (f *fakeAuth) Logout(context.Context, string) error { return f.err }

func TestHTTP_SignInSetsCookieAndAccessToken(t *testing.T) {
	accountID, userID, inboxID, sid := mustV7(t), mustV7(t), mustV7(t), mustV7(t)
	auth := &fakeAuth{out: gateway.AuthOut{
		UserID: userID, Email: "ada@acme.test", Name: "Ada",
		SessionID: sid, SessionToken: "sess-raw",
		Accounts: []gateway.AuthAccount{{
			AccountID: accountID, Role: "agent", InboxIDs: []uuid.UUID{inboxID},
		}},
	}}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Auth: auth},
	}).Handler())
	t.Cleanup(srv.Close)

	body, _ := json.Marshal(map[string]string{"email": "ada@acme.test", "password": "s3cret"})
	res, err := http.Post(srv.URL+"/auth/sign_in", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var got struct {
		AccessToken string `json:"access_token"`
		User        struct {
			AccountID string   `json:"account_id"`
			InboxIDs  []string `json:"inbox_ids"`
		} `json:"user"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.AccessToken == "" || got.User.AccountID != accountID.String() || got.User.InboxIDs[0] != inboxID.String() {
		t.Fatalf("%+v", got)
	}
	tok, err := gateway.Parse(secret, got.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	if tok.Sid != sid || !tok.AllowsInbox(inboxID) {
		t.Fatalf("%+v", tok)
	}
	found := false
	for _, c := range res.Cookies() {
		if c.Name == gateway.SessionCookie && c.Value == "sess-raw" && c.HttpOnly {
			found = true
		}
	}
	if !found {
		t.Fatalf("cookies %v", res.Cookies())
	}
}

func TestHTTP_SignInUnauthorized(t *testing.T) {
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Auth: &fakeAuth{err: context.Canceled}},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]string{"email": "ada@acme.test", "password": "nope"})
	res, err := http.Post(srv.URL+"/auth/sign_in", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", res.StatusCode)
	}
}
