package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/core"
)

type KakaoReplyOut struct {
	From        string
	To          string
	Template    string
	Phone       string
	SessionLive bool
}

type KakaoResolver interface {
	ResolveSender(ctx context.Context, senderKey string) (accountID, inboxID uuid.UUID, err error)
	ResolveKakao(ctx context.Context, accountID, inboxID uuid.UUID, msgKey, userKey string) (out CreateOut, found, duplicate bool, err error)
	CreateKakao(ctx context.Context, accountID, inboxID uuid.UUID, userKey, name, traceID string) (CreateOut, error)
	KakaoReply(ctx context.Context, actor, account, conversation uuid.UUID) (KakaoReplyOut, bool, error)
}

type KakaoSender interface {
	SendConsult(ctx context.Context, senderKey, userKey, message string) error
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
		Channel:  "kakao",
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

func (s *Service) DeliverKakaoOutbound(ctx context.Context, t OutboundTask) error {
	if s.KakaoSender == nil {
		return errors.New("kakao sender missing")
	}
	if strings.TrimSpace(t.From) == "" || strings.TrimSpace(t.To) == "" || strings.TrimSpace(t.Content) == "" {
		return ErrInvalid
	}
	if !t.SessionLive {
		return nil
	}
	return s.KakaoSender.SendConsult(ctx, t.From, t.To, t.Content)
}

type KakaoHub struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

func (h KakaoHub) SendConsult(ctx context.Context, senderKey, userKey, message string) error {
	return h.post(ctx, "/cstalk/plain", map[string]string{
		"userKey": userKey, "senderKey": senderKey, "msgType": "TEXT", "message": message,
	})
}

func (h KakaoHub) post(ctx context.Context, path string, body map[string]string) error {
	if h.BaseURL == "" {
		return errors.New("kakao api url missing")
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(h.BaseURL, "/")+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if h.Token != "" {
		req.Header.Set("Authorization", h.Token)
	}
	cli := h.Client
	if cli == nil {
		cli = http.DefaultClient
	}
	resp, err := cli.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("kakao http %d", resp.StatusCode)
	}
	return nil
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
