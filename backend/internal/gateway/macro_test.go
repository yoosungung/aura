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

type fakeMacros struct {
	out     gateway.MacroOut
	exec    gateway.ExecuteOut
	created []string
	ran     []uuid.UUID
	err     error
}

func (f *fakeMacros) ListMacros(context.Context, uuid.UUID, uuid.UUID) ([]gateway.MacroOut, error) {
	return []gateway.MacroOut{f.out}, f.err
}
func (f *fakeMacros) CreateMacro(_ context.Context, _, _ uuid.UUID, name, _ string, _ []core.MacroAction) (gateway.MacroOut, error) {
	f.created = append(f.created, name)
	return f.out, f.err
}
func (f *fakeMacros) UpdateMacro(_ context.Context, _, _, _ uuid.UUID, name, _ string, _ []core.MacroAction) (gateway.MacroOut, error) {
	f.created = append(f.created, name)
	return f.out, f.err
}
func (f *fakeMacros) DeleteMacro(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error {
	return f.err
}
func (f *fakeMacros) ExecuteMacro(_ context.Context, _, _, _, macroID uuid.UUID) (gateway.ExecuteOut, error) {
	f.ran = append(f.ran, macroID)
	return f.exec, f.err
}

func TestHTTP_ExecuteMacro(t *testing.T) {
	accountID, actorID, convID, macroID, msgID := mustV7(t), mustV7(t), mustV7(t), mustV7(t), mustV7(t)
	macros := &fakeMacros{exec: gateway.ExecuteOut{
		Status:  core.StatusResolved,
		Version: 2,
		Messages: []gateway.NoteOut{{
			MessageID: msgID, Content: "환불이 완료되었습니다.", Private: false,
		}},
		Labels: []gateway.LabelOut{{ID: mustV7(t), Name: "환불"}},
	}}
	srv := httptest.NewServer((&gateway.Server{
		Service: &gateway.Service{Secret: secret, Macros: macros},
	}).Handler())
	t.Cleanup(srv.Close)
	req, err := http.NewRequest(http.MethodPost,
		srv.URL+"/api/v1/accounts/"+accountID.String()+"/conversations/"+convID.String()+"/macros/"+macroID.String()+"/execute",
		bytes.NewReader([]byte("{}")))
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
	if len(macros.ran) != 1 || macros.ran[0] != macroID {
		t.Fatalf("%v", macros.ran)
	}
	var got struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil || got.Status != "resolved" {
		t.Fatalf("%+v %v", got, err)
	}
}
