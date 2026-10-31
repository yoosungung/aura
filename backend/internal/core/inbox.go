package core

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type InboxCreate struct {
	ActorUserID    uuid.UUID
	AccountID      uuid.UUID
	Name           string
	ChannelType    string
	EmailAddress   string
	KakaoSenderKey string
}

func (s *Service) ListInboxes(ctx context.Context, actor, account uuid.UUID) ([]InboxHMAC, error) {
	var out []InboxHMAC
	err := s.withAccountMember(ctx, actor, account, true, func(tx pgx.Tx, _ string) error {
		rows, err := tx.Query(ctx, `
			SELECT id, name, channel_type, COALESCE(greeting_message, ''),
				business_hours_enabled, business_hours,
				COALESCE(email_address, ''), COALESCE(kakao_sender_key, '')
			FROM inboxes ORDER BY name, id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var row InboxHMAC
			var hours []byte
			if err := rows.Scan(&row.ID, &row.Name, &row.ChannelType, &row.GreetingMessage,
				&row.BusinessHoursEnabled, &hours, &row.EmailAddress, &row.KakaoSenderKey); err != nil {
				return err
			}
			row.BusinessHours = hours
			out = append(out, row)
		}
		return rows.Err()
	})
	if out == nil {
		out = []InboxHMAC{}
	}
	return out, err
}

func (s *Service) CreateInbox(ctx context.Context, in InboxCreate) (InboxHMAC, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return InboxHMAC{}, ErrInvalid
	}
	ch, email, kakao, err := normalizeInboxChannel(in.ChannelType, in.EmailAddress, in.KakaoSenderKey)
	if err != nil {
		return InboxHMAC{}, err
	}
	var out InboxHMAC
	err = s.withAccountMember(ctx, in.ActorUserID, in.AccountID, true, func(tx pgx.Tx, _ string) error {
		inboxID, err := uuid.NewV7()
		if err != nil {
			return err
		}
		secret, err := randomHex(32)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO inboxes (id, account_id, name, channel_type, hmac_secret, email_address, kakao_sender_key)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			inboxID, in.AccountID, name, ch, secret, email, kakao); err != nil {
			if isUniqueViolation(err) {
				return ErrConflict
			}
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO inbox_members (account_id, inbox_id, user_id) VALUES ($1,$2,$3)`,
			in.AccountID, inboxID, in.ActorUserID); err != nil {
			return err
		}
		return scanInbox(tx, ctx, inboxID, &out)
	})
	return out, err
}

func (s *Service) DeleteInbox(ctx context.Context, in MemberInput) error {
	return s.withAdminInbox(ctx, in, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM inboxes WHERE id = $1`, in.InboxID)
		return err
	})
}

func normalizeInboxChannel(channel, email, kakao string) (string, any, any, error) {
	ch := strings.ToLower(strings.TrimSpace(channel))
	switch ch {
	case "web":
		return ch, nil, nil, nil
	case "email":
		addr := strings.ToLower(strings.TrimSpace(email))
		if addr == "" {
			return "", nil, nil, ErrInvalid
		}
		return ch, addr, nil, nil
	case "kakao":
		key := strings.TrimSpace(kakao)
		if key == "" {
			return "", nil, nil, ErrInvalid
		}
		return ch, nil, key, nil
	default:
		return "", nil, nil, ErrInvalid
	}
}

func ptrString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func nullIfBlank(v string) any {
	if v == "" {
		return nil
	}
	return v
}
