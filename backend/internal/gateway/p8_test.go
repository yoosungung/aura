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

type fakeMCP struct {
	got gateway.MCPOut
	err error
}

func (f *fakeMCP) ListMCP(context.Context, uuid.UUID, uuid.UUID) ([]gateway.MCPOut, error) {
	return []gateway.MCPOut{f.got}, f.err
}
func (f *fakeMCP) UpsertMCP(context.Context, uuid.UUID, uuid.UUID, string, string, string, []string, []string, *bool) (gateway.MCPOut, error) {
	return f.got, f.err
}
func (f *fakeMCP) DeleteMCP(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return f.err
}
func (f *fakeMCP) RotateMCP(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, string) (gateway.MCPOut, error) {
	return f.got, f.err
}

type fakeSkills struct {
	got gateway.SkillOut
	err error
}

func (f *fakeSkills) ListSkills(context.Context, uuid.UUID, uuid.UUID) ([]gateway.SkillOut, error) {
	return []gateway.SkillOut{f.got}, f.err
}
func (f *fakeSkills) UpsertSkill(context.Context, uuid.UUID, uuid.UUID, string, string, string, *bool) (gateway.SkillOut, error) {
	return f.got, f.err
}
func (f *fakeSkills) DeleteSkill(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return f.err
}

func TestHTTP_CreateMCPServer(t *testing.T) {
	accountID, actorID := mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, MCP: &fakeMCP{got: gateway.MCPOut{
			ID: mustV7(t), Name: "shop", URL: "https://ops.example/mcp", AuthHeader: "Bearer x", Enabled: true,
		}}},
	}).Handler())
	t.Cleanup(srv.Close)
	tok := userToken(t, accountID, actorID)
	body, _ := json.Marshal(map[string]any{"name": "shop", "url": "https://ops.example/mcp", "auth_header": "Bearer x"})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/accounts/"+accountID.String()+"/mcp_servers", bytes.NewReader(body))
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

func TestHTTP_RotateMCPAuth(t *testing.T) {
	accountID, actorID := mustV7(t), mustV7(t)
	serverID := mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, MCP: &fakeMCP{got: gateway.MCPOut{
			ID: serverID, Name: "shop", URL: "https://ops.example/mcp", AuthHeader: "Bearer new", Enabled: true,
		}}},
	}).Handler())
	t.Cleanup(srv.Close)
	tok := userToken(t, accountID, actorID)
	body, _ := json.Marshal(map[string]any{"auth_header": "Bearer new"})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/accounts/"+accountID.String()+"/mcp_servers/"+serverID.String()+"/auth/rotate", bytes.NewReader(body))
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

func TestHTTP_CreateAgentSkill(t *testing.T) {
	accountID, actorID := mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Skills: &fakeSkills{got: gateway.SkillOut{
			ID: mustV7(t), Name: "refund-policy", Body: "TENANT", Enabled: true,
		}}},
	}).Handler())
	t.Cleanup(srv.Close)
	tok := userToken(t, accountID, actorID)
	body, _ := json.Marshal(map[string]any{"name": "refund-policy", "body": "TENANT"})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/accounts/"+accountID.String()+"/agent_skills", bytes.NewReader(body))
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
