package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type InboxHMAC struct {
	ID          uuid.UUID
	Name        string
	ChannelType string
	HMACSecret  string
}

func (s *Service) GetInbox(ctx context.Context, in MemberInput) (InboxHMAC, error) {
	var out InboxHMAC
	err := s.withAdminInbox(ctx, in, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT id, name, channel_type, hmac_secret FROM inboxes WHERE id = $1`, in.InboxID,
		).Scan(&out.ID, &out.Name, &out.ChannelType, &out.HMACSecret)
	})
	return out, err
}

func (s *Service) RotateHMAC(ctx context.Context, in MemberInput) (InboxHMAC, error) {
	var out InboxHMAC
	err := s.withAdminInbox(ctx, in, func(tx pgx.Tx) error {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return err
		}
		secret := hex.EncodeToString(raw)
		return tx.QueryRow(ctx, `
			UPDATE inboxes SET hmac_secret = $2 WHERE id = $1
			RETURNING id, name, channel_type, hmac_secret`,
			in.InboxID, secret,
		).Scan(&out.ID, &out.Name, &out.ChannelType, &out.HMACSecret)
	})
	return out, err
}
