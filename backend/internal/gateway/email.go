package gateway

import (
	"bytes"
	"context"
	"path"
	"strings"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

const natsBodyLimit = 200_000

func (s *Service) AcceptEmail(ctx context.Context, raw []byte, envelopeFrom string, rcpt []string) error {
	if s.Email == nil || s.Bus == nil {
		return ErrInvalid
	}
	parsed, err := ParseMIME(raw)
	if err != nil {
		return err
	}
	if parsed.From == "" {
		parsed.From = normalizeAddr(envelopeFrom)
	}
	if parsed.From == "" {
		return ErrInvalid
	}
	if parsed.MessageID == "" {
		parsed.MessageID = newTraceID() + "@aura.invalid"
	}

	accountID, inboxID, err := s.resolveEmailInbox(ctx, parsed.To, rcpt)
	if err != nil {
		return err
	}

	content := parsed.Content
	if strings.TrimSpace(content) == "" {
		content = parsed.Subject
	}
	if strings.TrimSpace(content) == "" {
		return ErrInvalid
	}

	contentRef := ""
	if len(raw) > natsBodyLimit || len(content) > natsBodyLimit {
		if s.Blobs == nil {
			return ErrInvalid
		}
		key := path.Join(accountID.String(), "mime", sanitizeMessageID(parsed.MessageID)+".eml")
		url, err := s.Blobs.Put(ctx, key, bytes.NewReader(raw), int64(len(raw)), "message/rfc822")
		if err != nil {
			return err
		}
		contentRef = url
		if len(content) > 8192 {
			content = content[:8192]
		}
	}

	out, found, dup, err := s.Email.ResolveThread(ctx, accountID, inboxID, parsed.MessageID, parsed.ReplyIDs, parsed.DisplayID)
	if err != nil {
		return err
	}
	if dup {
		return nil
	}
	if !found {
		name := parsed.FromName
		if name == "" {
			name = parsed.From
		}
		out, err = s.Email.CreateEmail(ctx, accountID, inboxID, parsed.From, name, newTraceID())
		if err != nil {
			return err
		}
	}
	if out.ConversationID == uuid.Nil || out.ContactID == uuid.Nil || out.ContactInboxID == uuid.Nil {
		return ErrInvalid
	}

	_, _, err = s.publishMessage(ctx, accountID, inboxID, out.ConversationID, out.ContactID, out.ContactInboxID, out.ContactID, content, "Contact", MessageIncoming, messageMeta{
		SourceID:   parsed.MessageID,
		ContentRef: contentRef,
		Channel:    "email",
	})
	return err
}

func (s *Service) resolveEmailInbox(ctx context.Context, to string, rcpt []string) (uuid.UUID, uuid.UUID, error) {
	seen := map[string]bool{}
	var last error
	for _, c := range append([]string{to}, rcpt...) {
		addr := normalizeAddr(c)
		if addr == "" || seen[addr] {
			continue
		}
		seen[addr] = true
		accountID, inboxID, err := s.Email.ResolveInbox(ctx, addr)
		if err == nil {
			return accountID, inboxID, nil
		}
		last = err
	}
	if last == nil {
		last = core.ErrNotFound
	}
	return uuid.Nil, uuid.Nil, last
}

func sanitizeMessageID(id string) string {
	id = strings.ReplaceAll(id, "/", "_")
	id = strings.ReplaceAll(id, "..", "_")
	if id == "" {
		return "message"
	}
	return id
}
