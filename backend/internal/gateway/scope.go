package gateway

import (
	"encoding/json"

	"github.com/google/uuid"
)

func CanSubscribe(tok Token, inboxID, conversationID uuid.UUID) bool {
	if inboxID == uuid.Nil || conversationID == uuid.Nil || tok.AccountID == uuid.Nil {
		return false
	}
	switch tok.Kind {
	case KindContact:
		return tok.InboxID == inboxID && tok.ConversationID == conversationID
	case KindUser:
		return tok.AllowsInbox(inboxID)
	default:
		return false
	}
}

func HidePrivateFromContact(tok Token, raw []byte) bool {
	if tok.Kind != KindContact {
		return false
	}
	var payload struct {
		Message struct {
			Payload struct {
				Private bool `json:"private"`
			} `json:"payload"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return false
	}
	return payload.Message.Payload.Private
}

func (t Token) AllowsInbox(inboxID uuid.UUID) bool {
	if t.Kind == KindContact {
		return t.InboxID == inboxID
	}
	for _, id := range t.InboxIDs {
		if id == inboxID {
			return true
		}
	}
	return false
}
