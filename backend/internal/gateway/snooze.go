package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/yoosungung/aura/internal/core"
)

type Snoozer interface {
	Snooze(ctx context.Context, actor, account, conversation uuid.UUID, until time.Time, expectedVersion int) (SnoozeOut, error)
}

type SnoozeOut struct {
	Status       string
	Version      int
	SnoozedUntil time.Time
}

func (s *Server) handleSnooze(w http.ResponseWriter, r *http.Request) {
	if s.Service.Snooze == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	tok, err := s.bearer(r)
	if err != nil || tok.Kind != KindUser {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	accountID, err := uuid.Parse(r.PathValue("account_id"))
	if err != nil || accountID != tok.AccountID {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	conversationID, err := uuid.Parse(r.PathValue("conversation_id"))
	if err != nil {
		http.Error(w, "invalid conversation", http.StatusBadRequest)
		return
	}
	var body struct {
		SnoozedUntil    string `json:"snoozed_until"`
		ExpectedVersion int    `json:"expected_version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	until, err := time.Parse(time.RFC3339Nano, body.SnoozedUntil)
	if err != nil {
		http.Error(w, "invalid until", http.StatusBadRequest)
		return
	}
	out, err := s.Service.Snooze.Snooze(r.Context(), tok.UserID, accountID, conversationID, until, body.ExpectedVersion)
	if err != nil {
		code := http.StatusBadGateway
		if errors.Is(err, core.ErrDenied) || err.Error() == "forbidden" {
			code = http.StatusForbidden
		} else if errors.Is(err, core.ErrConflict) || err.Error() == "conflict" {
			code = http.StatusConflict
		} else if errors.Is(err, core.ErrNotFound) || err.Error() == "not_found" {
			code = http.StatusNotFound
		} else if errors.Is(err, core.ErrInvalid) || err.Error() == "invalid" {
			code = http.StatusBadRequest
		} else if errors.Is(err, core.ErrForbidden) {
			code = http.StatusForbidden
		}
		http.Error(w, err.Error(), code)
		return
	}
	if s.Service.Bus != nil {
		if err := s.Service.Bus.ScheduleSnoozeWake(r.Context(), accountID, conversationID, until); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":        out.Status,
		"version":       out.Version,
		"snoozed_until": out.SnoozedUntil.UTC().Format(time.RFC3339),
	})
}

func (r *natsRPC) Snooze(ctx context.Context, actor, account, conversation uuid.UUID, until time.Time, expectedVersion int) (SnoozeOut, error) {
	body, err := json.Marshal(map[string]any{
		"actor_user_id":    actor.String(),
		"account_id":       account.String(),
		"conversation_id":  conversation.String(),
		"snoozed_until":    until.UTC().Format(time.RFC3339),
		"expected_version": expectedVersion,
	})
	if err != nil {
		return SnoozeOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectSnooze, body)
	if err != nil {
		return SnoozeOut{}, err
	}
	var out struct {
		OK           bool   `json:"ok"`
		Error        string `json:"error"`
		Status       string `json:"status"`
		Version      int    `json:"version"`
		SnoozedUntil string `json:"snoozed_until"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return SnoozeOut{}, err
	}
	if !out.OK {
		return SnoozeOut{}, snoozeRPCErr(out.Error)
	}
	parsed, err := time.Parse(time.RFC3339Nano, out.SnoozedUntil)
	if err != nil {
		return SnoozeOut{}, err
	}
	return SnoozeOut{Status: out.Status, Version: out.Version, SnoozedUntil: parsed}, nil
}

func snoozeRPCErr(code string) error {
	switch code {
	case core.ErrDenied.Error():
		return core.ErrDenied
	case core.ErrConflict.Error():
		return core.ErrConflict
	case core.ErrNotFound.Error():
		return core.ErrNotFound
	case core.ErrInvalid.Error():
		return core.ErrInvalid
	case core.ErrForbidden.Error():
		return core.ErrForbidden
	case "":
		return fmt.Errorf("rpc_failed")
	default:
		return fmt.Errorf("%s", code)
	}
}

func (b *natsBus) ScheduleSnoozeWake(ctx context.Context, accountID, conversationID uuid.UUID, until time.Time) error {
	payload, err := json.Marshal(map[string]any{
		"account_id":      accountID.String(),
		"conversation_id": conversationID.String(),
	})
	if err != nil {
		return err
	}
	msg := &nats.Msg{
		Subject: core.SnoozeScheduleSubject(conversationID),
		Header: nats.Header{
			"Nats-Schedule":        []string{"@at " + until.UTC().Format(time.RFC3339)},
			"Nats-Schedule-Target": []string{core.SnoozeWakeSubject(conversationID)},
		},
		Data: payload,
	}
	_, err = b.js.PublishMsg(ctx, msg)
	return err
}
