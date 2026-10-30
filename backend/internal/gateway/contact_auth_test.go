package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/gateway"
)

type fakeContactAuth struct {
	out gateway.ContactAuthOut
	err error
}

func (f *fakeContactAuth) AuthContact(context.Context, uuid.UUID, string) (gateway.ContactAuthOut, error) {
	return f.out, f.err
}

func TestHTTP_ContactAuthExchangesSeed(t *testing.T) {
	accountID, inboxID, contactID, ciID, convID := mustV7(t), mustV7(t), mustV7(t), mustV7(t), mustV7(t)
	auth := &fakeContactAuth{out: gateway.ContactAuthOut{
		AccountID: accountID, InboxID: inboxID, ContactID: contactID,
		ContactInboxID: ciID, ConversationID: convID, SourceID: "widget-1",
	}}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, ContactAuth: auth},
	}).Handler())
	t.Cleanup(srv.Close)

	body, _ := json.Marshal(map[string]string{"pubsub_token": "seed"})
	res, err := http.Post(srv.URL+"/public/api/v1/inboxes/"+inboxID.String()+"/auth", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var got struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.AccessToken == "" || got.ExpiresIn != int(gateway.AccessTTL.Seconds()) {
		t.Fatalf("%+v", got)
	}
	tok, err := gateway.Parse(secret, got.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	if tok.Kind != gateway.KindContact || tok.AccountID != accountID || tok.InboxID != inboxID || tok.ContactID != contactID {
		t.Fatalf("%+v", tok)
	}
	if tok.ContactInboxID != ciID || tok.ConversationID != convID || tok.SourceID != "widget-1" {
		t.Fatalf("%+v", tok)
	}
}

func TestHTTP_ContactAuthUnauthorized(t *testing.T) {
	inboxID := mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, ContactAuth: &fakeContactAuth{err: core.ErrUnauthorized}},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]string{"pubsub_token": "nope"})
	res, err := http.Post(srv.URL+"/public/api/v1/inboxes/"+inboxID.String()+"/auth", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestHTTP_WidgetHTML(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "widget.html"), []byte("<title>Aura</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer((&gateway.Server{
		Service:   &gateway.Service{Secret: secret},
		WidgetDir: dir,
	}).Handler())
	t.Cleanup(srv.Close)
	res, err := http.Get(srv.URL + "/widget.html")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestHTTP_WidgetBundles(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"aura-loader.min.js", "widget.min.js"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("ok"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	srv := httptest.NewServer((&gateway.Server{
		Service:   &gateway.Service{Secret: secret},
		WidgetDir: dir,
	}).Handler())
	t.Cleanup(srv.Close)
	for _, path := range []string{"/aura-loader.min.js", "/widget.min.js"} {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s status %d", path, res.StatusCode)
		}
		res.Body.Close()
	}
}
