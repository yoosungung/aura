package gateway

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const AccessTTL = 15 * time.Minute

type Kind string

const (
	KindContact Kind = "contact"
	KindUser    Kind = "user"
)

type Token struct {
	Kind           Kind
	AccountID      uuid.UUID
	InboxID        uuid.UUID
	InboxIDs       []uuid.UUID
	UserID         uuid.UUID
	ContactID      uuid.UUID
	ContactInboxID uuid.UUID
	ConversationID uuid.UUID
	SourceID       string
	Exp            int64
	Sid            uuid.UUID
}

type tokenWire struct {
	Kind           string   `json:"k"`
	AccountID      string   `json:"account_id"`
	InboxID        string   `json:"inbox_id,omitempty"`
	InboxIDs       []string `json:"inbox_ids,omitempty"`
	UserID         string   `json:"user_id,omitempty"`
	ContactID      string   `json:"contact_id,omitempty"`
	ContactInboxID string   `json:"contact_inbox_id,omitempty"`
	ConversationID string   `json:"conversation_id,omitempty"`
	SourceID       string   `json:"source_id,omitempty"`
	Exp            int64    `json:"exp"`
	Sid            string   `json:"sid"`
}

func Sign(secret []byte, t Token) (string, error) {
	if len(secret) == 0 {
		return "", fmt.Errorf("empty secret")
	}
	if t.Exp == 0 {
		t.Exp = time.Now().Add(AccessTTL).Unix()
	}
	if t.Sid == uuid.Nil {
		id, err := uuid.NewV7()
		if err != nil {
			return "", err
		}
		t.Sid = id
	}
	raw, err := json.Marshal(t.wire())
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(raw)
	enc := base64.RawURLEncoding
	return enc.EncodeToString(raw) + "." + enc.EncodeToString(mac.Sum(nil)), nil
}

func Parse(secret []byte, s string) (Token, error) {
	if len(secret) == 0 || s == "" {
		return Token{}, fmt.Errorf("unauthorized")
	}
	payload, sig, ok := strings.Cut(s, ".")
	if !ok {
		return Token{}, fmt.Errorf("unauthorized")
	}
	enc := base64.RawURLEncoding
	raw, err := enc.DecodeString(payload)
	if err != nil {
		return Token{}, fmt.Errorf("unauthorized")
	}
	want, err := enc.DecodeString(sig)
	if err != nil {
		return Token{}, fmt.Errorf("unauthorized")
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(raw)
	if !hmac.Equal(mac.Sum(nil), want) {
		return Token{}, fmt.Errorf("unauthorized")
	}
	var w tokenWire
	if err := json.Unmarshal(raw, &w); err != nil {
		return Token{}, fmt.Errorf("unauthorized")
	}
	return fromWire(w)
}

func (t Token) wire() tokenWire {
	w := tokenWire{
		Kind:      string(t.Kind),
		AccountID: t.AccountID.String(),
		SourceID:  t.SourceID,
		Exp:       t.Exp,
		Sid:       t.Sid.String(),
	}
	if t.InboxID != uuid.Nil {
		w.InboxID = t.InboxID.String()
	}
	for _, id := range t.InboxIDs {
		w.InboxIDs = append(w.InboxIDs, id.String())
	}
	if t.UserID != uuid.Nil {
		w.UserID = t.UserID.String()
	}
	if t.ContactID != uuid.Nil {
		w.ContactID = t.ContactID.String()
	}
	if t.ContactInboxID != uuid.Nil {
		w.ContactInboxID = t.ContactInboxID.String()
	}
	if t.ConversationID != uuid.Nil {
		w.ConversationID = t.ConversationID.String()
	}
	return w
}

func fromWire(w tokenWire) (Token, error) {
	accountID, err := uuid.Parse(w.AccountID)
	if err != nil {
		return Token{}, fmt.Errorf("unauthorized")
	}
	if w.Exp == 0 || time.Now().Unix() >= w.Exp {
		return Token{}, fmt.Errorf("unauthorized")
	}
	sid := parseUUID(w.Sid)
	if sid == uuid.Nil {
		return Token{}, fmt.Errorf("unauthorized")
	}
	t := Token{Kind: Kind(w.Kind), AccountID: accountID, SourceID: w.SourceID, Exp: w.Exp, Sid: sid}
	t.InboxID = parseUUID(w.InboxID)
	t.UserID = parseUUID(w.UserID)
	t.ContactID = parseUUID(w.ContactID)
	t.ContactInboxID = parseUUID(w.ContactInboxID)
	t.ConversationID = parseUUID(w.ConversationID)
	for _, s := range w.InboxIDs {
		id := parseUUID(s)
		if id != uuid.Nil {
			t.InboxIDs = append(t.InboxIDs, id)
		}
	}
	if t.Kind != KindContact && t.Kind != KindUser {
		return Token{}, fmt.Errorf("unauthorized")
	}
	return t, nil
}

func parseUUID(s string) uuid.UUID {
	if s == "" {
		return uuid.Nil
	}
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil
	}
	return id
}
