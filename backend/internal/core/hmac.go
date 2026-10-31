package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"

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
	EmailAddress         string
	KakaoSenderKey       string
}

type InboxUpdate struct {
	MemberInput
	Name                 *string
	ChannelType          *string
	EmailAddress         *string
	KakaoSenderKey       *string
	GreetingMessage      *string
	BusinessHoursEnabled *bool
	BusinessHours        json.RawMessage
}

func scanInbox(tx pgx.Tx, ctx context.Context, inboxID uuid.UUID, out *InboxHMAC) error {
	var hours []byte
	err := tx.QueryRow(ctx, `
		SELECT id, name, channel_type, hmac_secret, COALESCE(greeting_message, ''),
			business_hours_enabled, business_hours,
			COALESCE(email_address, ''), COALESCE(kakao_sender_key, '')
		FROM inboxes WHERE id = $1`, inboxID,
	).Scan(&out.ID, &out.Name, &out.ChannelType, &out.HMACSecret, &out.GreetingMessage,
		&out.BusinessHoursEnabled, &hours, &out.EmailAddress, &out.KakaoSenderKey)
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
	var out InboxHMAC
	err := s.withAdminInbox(ctx, in.MemberInput, func(tx pgx.Tx) error {
		if in.Name != nil {
			name := strings.TrimSpace(*in.Name)
			if name == "" {
				return ErrInvalid
			}
			if _, err := tx.Exec(ctx, `UPDATE inboxes SET name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
				in.InboxID, name); err != nil {
				return err
			}
		}
		if in.ChannelType != nil {
			ch, email, kakao, err := normalizeInboxChannel(*in.ChannelType, ptrString(in.EmailAddress), ptrString(in.KakaoSenderKey))
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE inboxes SET channel_type = $2, email_address = $3, kakao_sender_key = $4,
					updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
				in.InboxID, ch, email, kakao); err != nil {
				if isUniqueViolation(err) {
					return ErrConflict
				}
				return err
			}
		} else if in.EmailAddress != nil || in.KakaoSenderKey != nil {
			if in.EmailAddress != nil {
				v := nullIfBlank(strings.ToLower(strings.TrimSpace(*in.EmailAddress)))
				if _, err := tx.Exec(ctx, `UPDATE inboxes SET email_address = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
					in.InboxID, v); err != nil {
					if isUniqueViolation(err) {
						return ErrConflict
					}
					return err
				}
			}
			if in.KakaoSenderKey != nil {
				v := nullIfBlank(strings.TrimSpace(*in.KakaoSenderKey))
				if _, err := tx.Exec(ctx, `UPDATE inboxes SET kakao_sender_key = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
					in.InboxID, v); err != nil {
					if isUniqueViolation(err) {
						return ErrConflict
					}
					return err
				}
			}
		}
		if in.GreetingMessage != nil || in.BusinessHoursEnabled != nil || len(in.BusinessHours) > 0 {
			hours := in.BusinessHours
			if len(hours) == 0 {
				hours = []byte("{}")
			}
			greeting := ""
			if in.GreetingMessage != nil {
				greeting = *in.GreetingMessage
			}
			hoursOn := false
			if in.BusinessHoursEnabled != nil {
				hoursOn = *in.BusinessHoursEnabled
			}
			if in.GreetingMessage == nil || in.BusinessHoursEnabled == nil {
				var cur InboxHMAC
				if err := scanInbox(tx, ctx, in.InboxID, &cur); err != nil {
					return err
				}
				if in.GreetingMessage == nil {
					greeting = cur.GreetingMessage
				}
				if in.BusinessHoursEnabled == nil {
					hoursOn = cur.BusinessHoursEnabled
				}
				if len(in.BusinessHours) == 0 {
					hours = cur.BusinessHours
				}
			}
			if _, err := tx.Exec(ctx, `
				UPDATE inboxes SET greeting_message = $2, business_hours_enabled = $3, business_hours = $4::jsonb,
					updated_at = CURRENT_TIMESTAMP
				WHERE id = $1`, in.InboxID, greeting, hoursOn, string(hours)); err != nil {
				return err
			}
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
