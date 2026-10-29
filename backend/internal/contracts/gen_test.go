package contracts

import (
	"encoding/json"
	"testing"
)

func TestMessageCreated_RoundTrip(t *testing.T) {
	in := MessageCreated{
		ID: "0192d4f0-8c00-7000-8000-111111111111", SchemaVersion: 1, Type: "message_created",
		OccurredAt: "2026-10-28T05:00:00Z", AccountID: "0192d4ef-0000-7000-8000-aaaaaaaaaaaa",
		InboxID: "0192d4ef-0000-7000-8000-bbbbbbbbbbbb", ConversationID: "0192d4ef-0000-7000-8000-cccccccccccc",
		TraceID: "4bf92f3577b34da6a3ce929d0e0e4736", HopCount: 0,
		Payload: MessageCreatedPayload{
			Content: "결제 오류입니다", MessageType: 0, Private: false, Status: "sent",
			ContentType: "text", SenderType: "Contact", SenderID: "dddddddd-dddd-dddd-dddd-dddddddddddd",
			ContactID: "dddddddd-dddd-dddd-dddd-dddddddddddd", ContactInboxID: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
			Attachments: []any{},
		},
	}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out MessageCreated
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out.Type != "message_created" || out.Payload.Content != "결제 오류입니다" || out.AccountID != in.AccountID {
		t.Fatalf("%+v", out)
	}
}

func TestConversationsRPC_RoundTrip(t *testing.T) {
	create, err := json.Marshal(ConversationsCreate{
		AccountID: "a", InboxID: "i", SourceID: "src", TraceID: "t", Name: "Ada",
	})
	if err != nil {
		t.Fatal(err)
	}
	var gotCreate ConversationsCreate
	if err := json.Unmarshal(create, &gotCreate); err != nil || gotCreate.SourceID != "src" || gotCreate.Name != "Ada" {
		t.Fatalf("%s %+v %v", create, gotCreate, err)
	}
	tr, err := json.Marshal(ConversationsTransition{
		AccountID: "a", ConversationID: "c", NewStatus: "open", ExpectedVersion: 1, TraceID: "t",
	})
	if err != nil {
		t.Fatal(err)
	}
	var gotTr ConversationsTransition
	if err := json.Unmarshal(tr, &gotTr); err != nil || gotTr.NewStatus != "open" || gotTr.ExpectedVersion != 1 {
		t.Fatalf("%s %+v %v", tr, gotTr, err)
	}
}
