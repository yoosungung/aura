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

type fakeIdentify struct {
	got  gateway.IdentifyOut
	err  error
	hash string
}

func (f *fakeIdentify) Identify(_ context.Context, _, _, _ uuid.UUID, _, hash, _, _ string) (gateway.IdentifyOut, error) {
	f.hash = hash
	return f.got, f.err
}

func TestHTTP_IdentifyContact(t *testing.T) {
	accountID, inboxID, contactID := mustV7(t), mustV7(t), mustV7(t)
	id := &fakeIdentify{got: gateway.IdentifyOut{ContactID: contactID, Identifier: "user-1", Name: "Ada"}}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Identify: id},
	}).Handler())
	t.Cleanup(srv.Close)
	tok, err := gateway.Sign(secret, gateway.Token{
		Kind: gateway.KindContact, AccountID: accountID, InboxID: inboxID, ContactID: contactID, Sid: mustV7(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/public/api/v1/inboxes/"+inboxID.String()+"/identify",
		strings.NewReader(`{"identifier":"user-1","identifier_hash":"abc","name":"Ada"}`))
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
		Identifier string `json:"identifier"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Identifier != "user-1" || id.hash != "abc" {
		t.Fatalf("%+v hash=%s", body, id.hash)
	}
}

func TestHTTP_IdentifyBadHash(t *testing.T) {
	accountID, inboxID, contactID := mustV7(t), mustV7(t), mustV7(t)
	id := &fakeIdentify{err: core.ErrUnauthorized}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Identify: id},
	}).Handler())
	t.Cleanup(srv.Close)
	tok, err := gateway.Sign(secret, gateway.Token{
		Kind: gateway.KindContact, AccountID: accountID, InboxID: inboxID, ContactID: contactID, Sid: mustV7(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/public/api/v1/inboxes/"+inboxID.String()+"/identify",
		strings.NewReader(`{"identifier":"user-1","identifier_hash":"nope"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", res.StatusCode)
	}
}
