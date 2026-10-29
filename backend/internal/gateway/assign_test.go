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

type fakeAssign struct {
	gotActor    uuid.UUID
	gotAssignee uuid.UUID
	out         gateway.AssignOut
	err         error
}

func (f *fakeAssign) Assign(_ context.Context, actor, _, _, assignee uuid.UUID, _ int) (gateway.AssignOut, error) {
	f.gotActor = actor
	f.gotAssignee = assignee
	return f.out, f.err
}

func TestHTTP_AssignConversation(t *testing.T) {
	accountID, actorID, convID, agentID := mustV7(t), mustV7(t), mustV7(t), mustV7(t)
	asg := &fakeAssign{out: gateway.AssignOut{AssigneeID: agentID, Status: "open", Version: 2}}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Assign: asg},
	}).Handler())
	t.Cleanup(srv.Close)

	body, _ := json.Marshal(map[string]any{"assignee_id": agentID.String(), "expected_version": 1})
	req, err := http.NewRequest(http.MethodPut,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/assignee",
		bytes.NewReader(body))
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
		AssigneeID string `json:"assignee_id"`
		Status     string `json:"status"`
		Version    int    `json:"version"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.AssigneeID != agentID.String() || got.Status != "open" || got.Version != 2 {
		t.Fatalf("%+v", got)
	}
	if asg.gotActor != actorID || asg.gotAssignee != agentID {
		t.Fatalf("rpc %+v", asg)
	}
}

func TestHTTP_AssignDenied(t *testing.T) {
	accountID, actorID, convID, agentID := mustV7(t), mustV7(t), mustV7(t), mustV7(t)
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Assign: &fakeAssign{err: core.ErrDenied}},
	}).Handler())
	t.Cleanup(srv.Close)
	body, _ := json.Marshal(map[string]any{"assignee_id": agentID.String(), "expected_version": 1})
	req, err := http.NewRequest(http.MethodPut,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/assignee",
		bytes.NewReader(body))
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
