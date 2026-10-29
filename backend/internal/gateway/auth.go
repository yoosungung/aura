package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

const SessionCookie = "aura_session"

type Authenticator interface {
	Login(ctx context.Context, email, password string) (AuthOut, error)
	Refresh(ctx context.Context, sessionToken string) (AuthOut, error)
	Logout(ctx context.Context, sessionToken string) error
}

type AuthAccount struct {
	AccountID uuid.UUID
	Role      string
	InboxIDs  []uuid.UUID
}

type AuthOut struct {
	UserID       uuid.UUID
	Email        string
	Name         string
	SessionID    uuid.UUID
	SessionToken string
	Accounts     []AuthAccount
}

func (s *Server) handleSignIn(w http.ResponseWriter, r *http.Request) {
	if s.Service.Auth == nil {
		http.Error(w, "auth unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	out, err := s.Service.Auth.Login(r.Context(), body.Email, body.Password)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	s.writeAuth(w, r, out)
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	if s.Service.Auth == nil {
		http.Error(w, "auth unavailable", http.StatusServiceUnavailable)
		return
	}
	c, err := r.Cookie(SessionCookie)
	if err != nil || c.Value == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	out, err := s.Service.Auth.Refresh(r.Context(), c.Value)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	s.writeAuth(w, r, out)
}

func (s *Server) handleSignOut(w http.ResponseWriter, r *http.Request) {
	if s.Service.Auth == nil {
		http.Error(w, "auth unavailable", http.StatusServiceUnavailable)
		return
	}
	c, err := r.Cookie(SessionCookie)
	if err == nil && c.Value != "" {
		_ = s.Service.Auth.Logout(r.Context(), c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) writeAuth(w http.ResponseWriter, r *http.Request, out AuthOut) {
	if len(out.Accounts) == 0 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	acc := out.Accounts[0]
	tok, err := Sign(s.Service.Secret, Token{
		Kind:      KindUser,
		AccountID: acc.AccountID,
		UserID:    out.UserID,
		InboxIDs:  acc.InboxIDs,
		Sid:       out.SessionID,
		Exp:       time.Now().Add(AccessTTL).Unix(),
	})
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    out.SessionToken,
		Path:     "/",
		MaxAge:   int(core.SessionTTL.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
	})
	inboxIDs := make([]string, 0, len(acc.InboxIDs))
	for _, id := range acc.InboxIDs {
		inboxIDs = append(inboxIDs, id.String())
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token": tok,
		"expires_in":   int(AccessTTL.Seconds()),
		"user": map[string]any{
			"id":         out.UserID.String(),
			"email":      out.Email,
			"name":       out.Name,
			"account_id": acc.AccountID.String(),
			"role":       acc.Role,
			"inbox_ids":  inboxIDs,
		},
	})
}
