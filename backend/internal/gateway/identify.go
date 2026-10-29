package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

type Identifier interface {
	Identify(ctx context.Context, account, inbox, contact uuid.UUID, identifier, hash, name, email string) (IdentifyOut, error)
}

type IdentifyOut struct {
	ContactID  uuid.UUID
	Identifier string
	Name       string
	Email      string
}

func (s *Server) handleIdentify(w http.ResponseWriter, r *http.Request) {
	tok, err := s.bearer(r)
	if err != nil || tok.Kind != KindContact {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	inboxID, err := uuid.Parse(r.PathValue("inbox_id"))
	if err != nil || inboxID != tok.InboxID {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if tok.ContactID == uuid.Nil {
		http.Error(w, "not_found", http.StatusNotFound)
		return
	}
	var body struct {
		Identifier     string `json:"identifier"`
		IdentifierHash string `json:"identifier_hash"`
		Name           string `json:"name"`
		Email          string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if s.Service.Identify == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	out, err := s.Service.Identify.Identify(r.Context(), tok.AccountID, inboxID, tok.ContactID, body.Identifier, body.IdentifierHash, body.Name, body.Email)
	if err != nil {
		code := http.StatusBadGateway
		if errors.Is(err, core.ErrUnauthorized) || err.Error() == "unauthorized" {
			code = http.StatusUnauthorized
		} else if errors.Is(err, core.ErrConflict) || err.Error() == "conflict" {
			code = http.StatusConflict
		} else if errors.Is(err, core.ErrNotFound) || err.Error() == "not_found" {
			code = http.StatusNotFound
		} else if errors.Is(err, core.ErrInvalid) || err.Error() == "invalid" {
			code = http.StatusBadRequest
		}
		http.Error(w, err.Error(), code)
		return
	}
	writeJSON(w, map[string]any{
		"contact_id": out.ContactID.String(), "identifier": out.Identifier, "name": out.Name, "email": out.Email,
	})
}

func (r *natsRPC) Identify(ctx context.Context, account, inbox, contact uuid.UUID, identifier, hash, name, email string) (IdentifyOut, error) {
	body, err := json.Marshal(map[string]any{
		"account_id": account.String(), "inbox_id": inbox.String(), "contact_id": contact.String(),
		"identifier": identifier, "identifier_hash": hash, "name": name, "email": email,
	})
	if err != nil {
		return IdentifyOut{}, err
	}
	msg, err := r.nc.RequestWithContext(ctx, core.SubjectContactIdentify, body)
	if err != nil {
		return IdentifyOut{}, err
	}
	var out struct {
		OK         bool   `json:"ok"`
		Error      string `json:"error"`
		ContactID  string `json:"contact_id"`
		Identifier string `json:"identifier"`
		Name       string `json:"name"`
		Email      string `json:"email"`
	}
	if err := json.Unmarshal(msg.Data, &out); err != nil {
		return IdentifyOut{}, err
	}
	if !out.OK {
		switch out.Error {
		case core.ErrUnauthorized.Error():
			return IdentifyOut{}, core.ErrUnauthorized
		case core.ErrConflict.Error():
			return IdentifyOut{}, core.ErrConflict
		case core.ErrNotFound.Error():
			return IdentifyOut{}, core.ErrNotFound
		case core.ErrInvalid.Error():
			return IdentifyOut{}, core.ErrInvalid
		case "":
			return IdentifyOut{}, fmt.Errorf("rpc_failed")
		default:
			return IdentifyOut{}, fmt.Errorf("%s", out.Error)
		}
	}
	id, err := uuid.Parse(out.ContactID)
	if err != nil {
		return IdentifyOut{}, err
	}
	return IdentifyOut{ContactID: id, Identifier: out.Identifier, Name: out.Name, Email: out.Email}, nil
}
