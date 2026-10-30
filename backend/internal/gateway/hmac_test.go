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

type fakeInboxes struct {
	got     gateway.InboxHMAC
	rotated gateway.InboxHMAC
	err     error
	gets    int
	rotates int
}

func (f *fakeInboxes) GetInbox(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (gateway.InboxHMAC, error) {
	f.gets++
	return f.got, f.err
}
func (f *fakeInboxes) RotateHMAC(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (gateway.InboxHMAC, error) {
	f.rotates++
	return f.rotated, f.err
}

func TestHTTP_AdminGetsAndRotatesInboxHMAC(t *testing.T) {
	accountID, actorID, inboxID := mustV7(t), mustV7(t), mustV7(t)
	box := &fakeInboxes{
		got:     gateway.InboxHMAC{ID: inboxID, Name: "web", ChannelType: "web", HMACSecret: "secret"},
		rotated: gateway.InboxHMAC{ID: inboxID, Name: "web", ChannelType: "web", HMACSecret: "newsecret"},
	}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Inboxes: box},
	}).Handler())
	t.Cleanup(srv.Close)
	tok := userToken(t, accountID, actorID)

	req, err := http.NewRequest(http.MethodGet,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/inboxes/"+inboxID.String(), nil)
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
		t.Fatalf("get %d", res.StatusCode)
	}
	var got struct {
		HMACSecret string `json:"hmac_secret"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.HMACSecret != "secret" || box.gets != 1 {
		t.Fatalf("%+v gets=%d", got, box.gets)
	}

	req, err = http.NewRequest(http.MethodPost,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/inboxes/"+inboxID.String()+"/hmac/rotate", nil)
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
		t.Fatalf("rotate %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.HMACSecret != "newsecret" || box.rotates != 1 {
		t.Fatalf("%+v rotates=%d", got, box.rotates)
	}
}

func TestHTTP_AgentDeniedInboxHMAC(t *testing.T) {
	accountID, actorID, inboxID := mustV7(t), mustV7(t), mustV7(t)
	box := &fakeInboxes{err: core.ErrDenied}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Inboxes: box},
	}).Handler())
	t.Cleanup(srv.Close)
	req, err := http.NewRequest(http.MethodGet,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/inboxes/"+inboxID.String(), nil)
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
