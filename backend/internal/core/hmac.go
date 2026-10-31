package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type InboxHMAC struct {
	ID                   uuid.UUID
	Name                 string
	ChannelType          string
	HMACSecret           string
	GreetingMessage      string
	BusinessHoursEnabled bool
	BusinessHours        json.RawMessage
}

type InboxUpdate struct {
	MemberInput
	GreetingMessage      string
	BusinessHoursEnabled bool
	BusinessHours        json.RawMessage
}

func scanInbox(tx pgx.Tx, ctx context.Context, inboxID uuid.UUID, out *InboxHMAC) error {
	var hours []byte
	err := tx.QueryRow(ctx, `
		SELECT id, name, channel_type, hmac_secret, COALESCE(greeting_message, ''),
			business_hours_enabled, business_hours
		FROM inboxes WHERE id = $1`, inboxID,
	).Scan(&out.ID, &out.Name, &out.ChannelType, &out.HMACSecret, &out.GreetingMessage,
		&out.BusinessHoursEnabled, &hours)
	if err != nil {
		return err
	}
	out.BusinessHours = hours
	return nil
}

func (s *Service) GetInbox(ctx context.Context, in MemberInput) (InboxHMAC, error) {
	var out InboxHMAC
	err := s.withAdminInbox(ctx, in, func(tx pgx.Tx) error {
		return scanInbox(tx, ctx, in.InboxID, &out)
	})
	return out, err
}

func (s *Service) UpdateInbox(ctx context.Context, in InboxUpdate) (InboxHMAC, error) {
	hours := in.BusinessHours
	if len(hours) == 0 {
		hours = []byte("{}")
	}
	var out InboxHMAC
	err := s.withAdminInbox(ctx, in.MemberInput, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE inboxes SET greeting_message = $2, business_hours_enabled = $3, business_hours = $4::jsonb,
				updated_at = CURRENT_TIMESTAMP
			WHERE id = $1`, in.InboxID, in.GreetingMessage, in.BusinessHoursEnabled, string(hours)); err != nil {
			return err
		}
		return scanInbox(tx, ctx, in.InboxID, &out)
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
		if _, err := tx.Exec(ctx, `UPDATE inboxes SET hmac_secret = $2 WHERE id = $1`, in.InboxID, secret); err != nil {
			return err
		}
		return scanInbox(tx, ctx, in.InboxID, &out)
	})
	return out, err
}
