package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/contracts"
)

const (
	MessageIncoming = 0
	MessageOutgoing = 1
)

var (
	ErrForbidden = errors.New("forbidden")
	ErrInvalid   = errors.New("invalid")
)

type Creator interface {
	Create(ctx context.Context, accountID, inboxID uuid.UUID, sourceID, name, traceID string) (CreateOut, error)
}

type Bus interface {
	PublishEvent(ctx context.Context, subject string, data []byte) error
	PublishRealtime(subject string, data []byte) error
	ScheduleSnoozeWake(ctx context.Context, accountID, conversationID uuid.UUID, until time.Time) error
}

type CreateOut struct {
	ContactID      uuid.UUID
	ContactInboxID uuid.UUID
	ConversationID uuid.UUID
	DisplayID      int64
}

type SubmitRequest struct {
	Content        string
	SourceID       string
	Name           string
	InboxID        uuid.UUID
	ContactID      uuid.UUID
	ContactInboxID uuid.UUID
	ConversationID uuid.UUID
}

type SubmitResult struct {
	MessageID      uuid.UUID
	ConversationID uuid.UUID
	ContactID      uuid.UUID
	ContactInboxID uuid.UUID
	DisplayID      int64
	Token          string
	Attachments    []AttachmentOut
}

type EmailReplyOut struct {
	From      string
	To        string
	InReplyTo string
	DisplayID int64
}

type EmailResolver interface {
	ResolveInbox(ctx context.Context, email string) (accountID, inboxID uuid.UUID, err error)
	ResolveThread(ctx context.Context, accountID, inboxID uuid.UUID, sourceID string, replyIDs []string, displayID int64) (out CreateOut, found, duplicate bool, err error)
	CreateEmail(ctx context.Context, accountID, inboxID uuid.UUID, sourceID, name, traceID string) (CreateOut, error)
	EmailReply(ctx context.Context, actor, account, conversation uuid.UUID) (EmailReplyOut, bool, error)
}

type Service struct {
	Secret   []byte
	RPC      Creator
	Email    EmailResolver
	Auth     Authenticator
	Members  Members
	Inboxes  Inboxes
	Assign   Assigner
	Notes    Noter
	Snooze   Snoozer
	Labels   Labeler
	Canned   CannedStore
	Macros   MacroStore
	Catalog  Catalog
	Identify Identifier
	Bus      Bus
	Blobs    BlobStore
	JS       jetstream.JetStream
	Mailer   Mailer
	Kakao    KakaoResolver
}

func (s *Service) SubmitContact(ctx context.Context, tok Token, inboxID uuid.UUID, req SubmitRequest) (SubmitResult, error) {
	if tok.Kind != KindContact || tok.AccountID == uuid.Nil || inboxID == uuid.Nil || inboxID != tok.InboxID {
		return SubmitResult{}, ErrForbidden
	}
	if strings.TrimSpace(req.Content) == "" {
		return SubmitResult{}, ErrInvalid
	}
	contactID := firstUUID(req.ContactID, tok.ContactID)
	contactInboxID := firstUUID(req.ContactInboxID, tok.ContactInboxID)
	conversationID := firstUUID(req.ConversationID, tok.ConversationID)
	displayID := int64(0)
	if conversationID == uuid.Nil {
		sourceID := req.SourceID
		if sourceID == "" {
			sourceID = tok.SourceID
		}
		if sourceID == "" {
			return SubmitResult{}, ErrInvalid
		}
		out, err := s.RPC.Create(ctx, tok.AccountID, inboxID, sourceID, req.Name, newTraceID())
		if err != nil {
			return SubmitResult{}, err
		}
		contactID = out.ContactID
		contactInboxID = out.ContactInboxID
		conversationID = out.ConversationID
		displayID = out.DisplayID
	}
	if contactID == uuid.Nil || contactInboxID == uuid.Nil || conversationID == uuid.Nil {
		return SubmitResult{}, ErrInvalid
	}
	msgID, _, err := s.publishMessage(ctx, tok.AccountID, inboxID, conversationID, contactID, contactInboxID, tok.ContactID, req.Content, "Contact", MessageIncoming, messageMeta{})
	if err != nil {
		return SubmitResult{}, err
	}
	signed, err := Sign(s.Secret, Token{
		Kind:           KindContact,
		AccountID:      tok.AccountID,
		InboxID:        inboxID,
		SourceID:       firstNonEmpty(req.SourceID, tok.SourceID),
		ContactID:      contactID,
		ContactInboxID: contactInboxID,
		ConversationID: conversationID,
	})
	if err != nil {
		return SubmitResult{}, err
	}
	return SubmitResult{
		MessageID:      msgID,
		ConversationID: conversationID,
		ContactID:      contactID,
		ContactInboxID: contactInboxID,
		DisplayID:      displayID,
		Token:          signed,
	}, nil
}

func (s *Service) SubmitAgent(ctx context.Context, tok Token, accountID, conversationID uuid.UUID, req SubmitRequest) (SubmitResult, error) {
	if tok.Kind != KindUser || tok.AccountID == uuid.Nil || accountID != tok.AccountID {
		return SubmitResult{}, ErrForbidden
	}
	if !tok.AllowsInbox(req.InboxID) {
		return SubmitResult{}, ErrForbidden
	}
	if strings.TrimSpace(req.Content) == "" || conversationID == uuid.Nil || req.ContactID == uuid.Nil || req.ContactInboxID == uuid.Nil {
		return SubmitResult{}, ErrInvalid
	}
	meta := messageMeta{}
	var reply EmailReplyOut
	if s.Email != nil {
		out, skip, err := s.Email.EmailReply(ctx, tok.UserID, accountID, conversationID)
		if err != nil {
			return SubmitResult{}, err
		}
		if !skip {
			meta.SourceID = newTraceID() + "@aura.invalid"
			reply = out
		}
	}
	msgID, _, err := s.publishMessage(ctx, accountID, req.InboxID, conversationID, req.ContactID, req.ContactInboxID, tok.UserID, req.Content, "User", MessageOutgoing, meta)
	if err != nil {
		return SubmitResult{}, err
	}
	if meta.SourceID != "" {
		task, err := json.Marshal(OutboundTask{
			AccountID: accountID.String(), InboxID: req.InboxID.String(),
			ConversationID: conversationID.String(), MessageID: msgID.String(),
			From: reply.From, To: reply.To, Content: req.Content,
			InReplyTo: reply.InReplyTo, SourceID: meta.SourceID, DisplayID: reply.DisplayID,
		})
		if err != nil {
			return SubmitResult{}, err
		}
		if err := s.Bus.PublishEvent(ctx, OutboundEmailSubject, task); err != nil {
			return SubmitResult{}, err
		}
	}
	return SubmitResult{
		MessageID:      msgID,
		ConversationID: conversationID,
		ContactID:      req.ContactID,
		ContactInboxID: req.ContactInboxID,
	}, nil
}

type messageMeta struct {
	SourceID    string
	ContentRef  string
	Attachments []any
}

func (s *Service) publishMessage(ctx context.Context, accountID, inboxID, conversationID, contactID, contactInboxID, senderID uuid.UUID, content, senderType string, messageType int, meta messageMeta) (uuid.UUID, []byte, error) {
	msgID, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, nil, err
	}
	if senderID == uuid.Nil {
		senderID = contactID
	}
	if meta.Attachments == nil {
		meta.Attachments = []any{}
	}
	traceID := newTraceID()
	env, err := json.Marshal(contracts.MessageCreated{
		ID: msgID.String(), SchemaVersion: 1, Type: "message_created",
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		AccountID:  accountID.String(), InboxID: inboxID.String(),
		ConversationID: conversationID.String(), TraceID: traceID, HopCount: 0,
		Payload: contracts.MessageCreatedPayload{
			Content: content, ContentRef: meta.ContentRef, MessageType: messageType, Private: false, Status: "sent",
			ContentType: "text", SourceID: meta.SourceID, SenderType: senderType, SenderID: senderID.String(),
			ContactID: contactID.String(), ContactInboxID: contactInboxID.String(),
			Attachments: meta.Attachments,
		},
	})
	if err != nil {
		return uuid.Nil, nil, err
	}
	subject := fmt.Sprintf("helpdesk.events.%s.%s.%s.message_created", accountID, inboxID, conversationID)
	if err := s.Bus.PublishEvent(ctx, subject, env); err != nil {
		return uuid.Nil, nil, err
	}
	rt, err := json.Marshal(map[string]any{
		"type":            "event",
		"event":           "message.created",
		"account_id":      accountID.String(),
		"inbox_id":        inboxID.String(),
		"conversation_id": conversationID.String(),
		"message":         json.RawMessage(env),
	})
	if err != nil {
		return uuid.Nil, nil, err
	}
	rtSubject := fmt.Sprintf("helpdesk.realtime.%s.%s.updated", accountID, conversationID)
	if err := s.Bus.PublishRealtime(rtSubject, rt); err != nil {
		return uuid.Nil, nil, err
	}
	return msgID, env, nil
}

func firstUUID(a, b uuid.UUID) uuid.UUID {
	if a != uuid.Nil {
		return a
	}
	return b
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func newTraceID() string {
	return strings.ReplaceAll(uuid.NewString(), "-", "")
}
