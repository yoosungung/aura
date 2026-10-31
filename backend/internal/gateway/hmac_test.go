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

type fakeInboxes struct {
	got     gateway.InboxHMAC
	rotated gateway.InboxHMAC
	updated gateway.InboxHMAC
	created gateway.InboxHMAC
	list    []gateway.InboxHMAC
	err     error
	gets    int
	rotates int
	updates int
	lists   int
	creates int
	deletes int
	patch   gateway.InboxPatch
}

func (f *fakeInboxes) GetInbox(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (gateway.InboxHMAC, error) {
	f.gets++
	return f.got, f.err
}
func (f *fakeInboxes) RotateHMAC(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (gateway.InboxHMAC, error) {
	f.rotates++
	return f.rotated, f.err
}
func (f *fakeInboxes) UpdateInbox(_ context.Context, _, _, _ uuid.UUID, patch gateway.InboxPatch) (gateway.InboxHMAC, error) {
	f.updates++
	f.patch = patch
	greeting := ""
	if patch.GreetingMessage != nil {
		greeting = *patch.GreetingMessage
	}
	hoursOn := false
	if patch.BusinessHoursEnabled != nil {
		hoursOn = *patch.BusinessHoursEnabled
	}
	f.updated = gateway.InboxHMAC{
		ID: f.got.ID, Name: f.got.Name, ChannelType: f.got.ChannelType, HMACSecret: f.got.HMACSecret,
		GreetingMessage: greeting, BusinessHoursEnabled: hoursOn, BusinessHours: patch.BusinessHours,
	}
	if patch.Name != nil {
		f.updated.Name = *patch.Name
	}
	return f.updated, f.err
}
func (f *fakeInboxes) ListInboxes(context.Context, uuid.UUID, uuid.UUID) ([]gateway.InboxHMAC, error) {
	f.lists++
	return f.list, f.err
}
func (f *fakeInboxes) CreateInbox(_ context.Context, _, _ uuid.UUID, name, channel, email, kakao string) (gateway.InboxHMAC, error) {
	f.creates++
	f.created = gateway.InboxHMAC{ID: f.got.ID, Name: name, ChannelType: channel, HMACSecret: "new", EmailAddress: email, KakaoSenderKey: kakao}
	return f.created, f.err
}
func (f *fakeInboxes) DeleteInbox(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error {
	f.deletes++
	return f.err
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

func TestHTTP_AdminPatchesInboxGreeting(t *testing.T) {
	accountID, actorID, inboxID := mustV7(t), mustV7(t), mustV7(t)
	box := &fakeInboxes{got: gateway.InboxHMAC{ID: inboxID, Name: "web", ChannelType: "web", HMACSecret: "secret"}}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Inboxes: box},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]any{
		"greeting_message": "부재중", "business_hours_enabled": true,
		"business_hours": map[string]any{"timezone": "Asia/Seoul"},
	})
	req, err := http.NewRequest(http.MethodPatch,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/inboxes/"+inboxID.String(), bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+userToken(t, accountID, actorID))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var got struct {
		Greeting string `json:"greeting_message"`
		HoursOn  bool   `json:"business_hours_enabled"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Greeting != "부재중" || !got.HoursOn || box.updates != 1 {
		t.Fatalf("%+v updates=%d", got, box.updates)
	}
}

func TestHTTP_ChannelsFromEnv(t *testing.T) {
	accountID, actorID := mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service:         &gateway.Service{Secret: secret},
		EnabledChannels: []string{"web", "kakao"},
	}).Handler())
	t.Cleanup(srv.Close)
	req, err := http.NewRequest(http.MethodGet,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/channels", nil)
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
		ChannelTypes []string `json:"channel_types"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.ChannelTypes) != 2 || got.ChannelTypes[0] != "web" || got.ChannelTypes[1] != "kakao" {
		t.Fatalf("%+v", got)
	}
}

func TestEnabledChannelTypes(t *testing.T) {
	got := gateway.EnabledChannelTypes("")
	if len(got) != 3 || got[0] != "web" {
		t.Fatalf("%v", got)
	}
	got = gateway.EnabledChannelTypes("web, social, kakao,web")
	if len(got) != 2 || got[0] != "web" || got[1] != "kakao" {
		t.Fatalf("%v", got)
	}
	got = gateway.EnabledChannelTypes("social")
	if len(got) != 3 {
		t.Fatalf("empty after filter %v", got)
	}
}

func TestHTTP_InboxCollection(t *testing.T) {
	accountID, actorID, inboxID := mustV7(t), mustV7(t), mustV7(t)
	box := &fakeInboxes{
		got:  gateway.InboxHMAC{ID: inboxID},
		list: []gateway.InboxHMAC{{ID: inboxID, Name: "Web", ChannelType: "web", HMACSecret: "secret"}},
	}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Inboxes: box},
	}).Handler())
	t.Cleanup(srv.Close)
	tok := userToken(t, accountID, actorID)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/accounts/"+accountID.String()+"/inboxes", nil)
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
		t.Fatalf("list %d", res.StatusCode)
	}
	var listed struct {
		Inboxes []struct {
			Name       string `json:"name"`
			HMACSecret string `json:"hmac_secret"`
		} `json:"inboxes"`
	}
	if err := json.NewDecoder(res.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Inboxes) != 1 || listed.Inboxes[0].Name != "Web" || listed.Inboxes[0].HMACSecret != "" || box.lists != 1 {
		t.Fatalf("%+v lists=%d", listed, box.lists)
	}

	body, _ := json.Marshal(map[string]any{"name": "Mail", "channel_type": "email", "email_address": "help@acme.test"})
	req, err = http.NewRequest(http.MethodPost, srv.URL+"/api/v1/accounts/"+accountID.String()+"/inboxes", bytes.NewReader(body))
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
		t.Fatalf("create %d", res.StatusCode)
	}
	var created struct {
		Name       string `json:"name"`
		HMACSecret string `json:"hmac_secret"`
	}
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Name != "Mail" || created.HMACSecret != "new" || box.creates != 1 {
		t.Fatalf("%+v creates=%d", created, box.creates)
	}

	body, _ = json.Marshal(map[string]any{"name": "Social", "channel_type": "social"})
	req, err = http.NewRequest(http.MethodPost, srv.URL+"/api/v1/accounts/"+accountID.String()+"/inboxes", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("social %d", res.StatusCode)
	}

	req, err = http.NewRequest(http.MethodDelete,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/inboxes/"+inboxID.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent || box.deletes != 1 {
		t.Fatalf("delete %d deletes=%d", res.StatusCode, box.deletes)
	}
}
