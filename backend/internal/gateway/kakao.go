package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

type KakaoResolver interface {
	ResolveSender(ctx context.Context, senderKey string) (accountID, inboxID uuid.UUID, err error)
	ResolveKakao(ctx context.Context, accountID, inboxID uuid.UUID, msgKey, userKey string) (out CreateOut, found, duplicate bool, err error)
	CreateKakao(ctx context.Context, accountID, inboxID uuid.UUID, userKey, name, traceID string) (CreateOut, error)
}

type kakaoWebhook struct {
	MsgKey      string `json:"msgKey"`
	UserKey     string `json:"userKey"`
	SenderKey   string `json:"senderKey"`
	RequestType string `json:"requestType"`
	Contents    []struct {
		Comment string `json:"comment"`
		URL     string `json:"url"`
	} `json:"contents"`
}

func (s *Service) AcceptKakao(ctx context.Context, raw []byte) error {
	if s.Kakao == nil || s.Bus == nil {
		return ErrInvalid
	}
	var hook kakaoWebhook
	if err := json.Unmarshal(raw, &hook); err != nil {
		return ErrInvalid
	}
	if hook.RequestType != "" && hook.RequestType != "message" {
		return nil
	}
	hook.SenderKey = strings.TrimSpace(hook.SenderKey)
	hook.UserKey = strings.TrimSpace(hook.UserKey)
	hook.MsgKey = strings.TrimSpace(hook.MsgKey)
	content := kakaoContent(hook)
	if hook.SenderKey == "" || hook.UserKey == "" || hook.MsgKey == "" || content == "" {
		return ErrInvalid
	}
	accountID, inboxID, err := s.Kakao.ResolveSender(ctx, hook.SenderKey)
	if err != nil {
		return err
	}
	out, found, dup, err := s.Kakao.ResolveKakao(ctx, accountID, inboxID, hook.MsgKey, hook.UserKey)
	if err != nil {
		return err
	}
	if dup {
		return nil
	}
	if !found {
		out, err = s.Kakao.CreateKakao(ctx, accountID, inboxID, hook.UserKey, hook.UserKey, newTraceID())
		if err != nil {
			return err
		}
	}
	if out.ConversationID == uuid.Nil || out.ContactID == uuid.Nil || out.ContactInboxID == uuid.Nil {
		return ErrInvalid
	}
	_, _, err = s.publishMessage(ctx, accountID, inboxID, out.ConversationID, out.ContactID, out.ContactInboxID, out.ContactID, content, "Contact", MessageIncoming, messageMeta{
		SourceID: hook.MsgKey,
	})
	return err
}

func kakaoContent(hook kakaoWebhook) string {
	var parts []string
	for _, c := range hook.Contents {
		text := strings.TrimSpace(c.Comment)
		if text == "" {
			text = strings.TrimSpace(c.URL)
		}
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func (s *Server) KakaoHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /cstalk/message", s.handleCstalkMessage)
	return mux
}

func (s *Server) handleCstalkMessage(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	err = s.Service.AcceptKakao(r.Context(), raw)
	if err != nil && !errors.Is(err, core.ErrNotFound) && !errors.Is(err, ErrInvalid) {
		http.Error(w, "temporary failure", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"code": "A000", "result": "Success"})
}
