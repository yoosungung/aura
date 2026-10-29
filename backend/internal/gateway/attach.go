package gateway

import (
	"context"
	"fmt"
	"io"
	"path"

	"github.com/google/uuid"
)

type AttachmentOut struct {
	ID          string
	FileType    string
	ExternalURL string
	FileSize    int
}

type AttachRequest struct {
	InboxID        uuid.UUID
	ContactID      uuid.UUID
	ContactInboxID uuid.UUID
	Filename       string
	ContentType    string
	Size           int64
	Body           io.Reader
}

func (s *Service) SubmitAttachment(ctx context.Context, tok Token, accountID, conversationID uuid.UUID, req AttachRequest) (SubmitResult, error) {
	if tok.Kind != KindUser || tok.AccountID == uuid.Nil || accountID != tok.AccountID {
		return SubmitResult{}, ErrForbidden
	}
	if !tok.AllowsInbox(req.InboxID) {
		return SubmitResult{}, ErrForbidden
	}
	if s.Blobs == nil || conversationID == uuid.Nil || req.ContactID == uuid.Nil || req.ContactInboxID == uuid.Nil {
		return SubmitResult{}, ErrInvalid
	}
	filename := sanitizeFilename(req.Filename)
	if req.Body == nil || filename == "" {
		return SubmitResult{}, ErrInvalid
	}
	attID, err := uuid.NewV7()
	if err != nil {
		return SubmitResult{}, err
	}
	key := path.Join(accountID.String(), attID.String(), filename)
	url, err := s.Blobs.Put(ctx, key, req.Body, req.Size, req.ContentType)
	if err != nil {
		return SubmitResult{}, fmt.Errorf("blob: %w", err)
	}
	fileType := ClassifyFileType(req.ContentType, filename)
	size := int(req.Size)
	att := map[string]any{
		"id": attID.String(), "file_type": fileType, "external_url": url, "file_size": size,
	}
	msgID, _, err := s.publishMessage(ctx, accountID, req.InboxID, conversationID, req.ContactID, req.ContactInboxID, tok.UserID, filename, "User", MessageOutgoing, messageMeta{Attachments: []any{att}})
	if err != nil {
		return SubmitResult{}, err
	}
	return SubmitResult{
		MessageID:      msgID,
		ConversationID: conversationID,
		ContactID:      req.ContactID,
		ContactInboxID: req.ContactInboxID,
		Attachments: []AttachmentOut{{
			ID: attID.String(), FileType: fileType, ExternalURL: url, FileSize: size,
		}},
	}, nil
}
