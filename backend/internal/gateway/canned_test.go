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

type fakeCanned struct {
	out gateway.CannedOut
	err error
}

func (f *fakeCanned) ListCanned(context.Context, uuid.UUID, uuid.UUID) ([]gateway.CannedOut, error) {
	return []gateway.CannedOut{f.out}, f.err
}
func (f *fakeCanned) CreateCanned(context.Context, uuid.UUID, uuid.UUID, string, string) (gateway.CannedOut, error) {
	return f.out, f.err
}
func (f *fakeCanned) DeleteCanned(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return f.err
}

func TestHTTP_CreateCanned(t *testing.T) {
	accountID, actorID, id := mustV7(t), mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Canned: &fakeCanned{out: gateway.CannedOut{ID: id, ShortCode: "인사", Content: "안녕하세요"}}},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]any{"short_code": "인사", "content": "안녕하세요"})
	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/canned_responses", bytes.NewReader(body))
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
		ShortCode string `json:"short_code"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil || got.ShortCode != "인사" {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestHTTP_CannedDenied(t *testing.T) {
	accountID, actorID := mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Canned: &fakeCanned{err: core.ErrDenied}},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]any{"short_code": "인사", "content": "안녕하세요"})
	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/canned_responses", bytes.NewReader(body))
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
