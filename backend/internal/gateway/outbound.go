package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/emersion/go-smtp"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/ingest"
)

const (
	OutboundEmailSubject = "helpdesk.tasks.outbound.email"
	OutboundKakaoSubject = "helpdesk.tasks.outbound.kakao"
)

type Mailer interface {
	Send(from string, to []string, raw []byte) error
}

type SMTPRelay struct {
	Addr string
}

func (m SMTPRelay) Send(from string, to []string, raw []byte) error {
	if m.Addr == "" {
		return ErrInvalid
	}
	c, err := smtp.Dial(m.Addr)
	if err != nil {
		return err
	}
	defer c.Close()
	if err := c.SendMail(from, to, bytes.NewReader(raw)); err != nil {
		return err
	}
	return c.Quit()
}

type OutboundTask struct {
	AccountID      string `json:"account_id"`
	InboxID        string `json:"inbox_id"`
	ConversationID string `json:"conversation_id"`
	MessageID      string `json:"message_id"`
	From           string `json:"from"`
	To             string `json:"to"`
	Content        string `json:"content"`
	InReplyTo      string `json:"in_reply_to"`
	SourceID       string `json:"source_id"`
	DisplayID      int64  `json:"display_id"`
	SessionLive    bool   `json:"session_live"`
	Template       string `json:"template"`
	Phone          string `json:"phone"`
}

func (s *Service) DeliverOutbound(ctx context.Context, t OutboundTask) error {
	if s.Mailer == nil {
		return errors.New("mailer missing")
	}
	raw, err := BuildOutboundMIME(OutboundMail{
		From: t.From, To: t.To, Content: t.Content,
		MessageID: t.SourceID, InReplyTo: t.InReplyTo, DisplayID: t.DisplayID,
	})
	if err != nil {
		return err
	}
	return s.Mailer.Send(t.From, []string{t.To}, raw)
}

func (s *Service) ConsumeOutbound(ctx context.Context) error {
	if s.JS == nil {
		<-ctx.Done()
		return ctx.Err()
	}
	cons, err := s.JS.CreateOrUpdateConsumer(ctx, ingest.TasksStream, jetstream.ConsumerConfig{
		Durable:       ingest.OutboundEmailConsumer,
		FilterSubject: OutboundEmailSubject,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	})
	if err != nil {
		return err
	}
	cc, err := cons.Consume(func(msg jetstream.Msg) {
		s.handleOutbound(msg)
	})
	if err != nil {
		return err
	}
	defer cc.Stop()
	<-ctx.Done()
	return ctx.Err()
}

func (s *Service) ConsumeKakaoOutbound(ctx context.Context) error {
	if s.JS == nil {
		<-ctx.Done()
		return ctx.Err()
	}
	cons, err := s.JS.CreateOrUpdateConsumer(ctx, ingest.TasksStream, jetstream.ConsumerConfig{
		Durable:       ingest.OutboundKakaoConsumer,
		FilterSubject: OutboundKakaoSubject,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	})
	if err != nil {
		return err
	}
	cc, err := cons.Consume(func(msg jetstream.Msg) {
		s.handleKakaoOutbound(msg)
	})
	if err != nil {
		return err
	}
	defer cc.Stop()
	<-ctx.Done()
	return ctx.Err()
}

func (s *Service) handleKakaoOutbound(msg jetstream.Msg) {
	var t OutboundTask
	if err := json.Unmarshal(msg.Data(), &t); err != nil {
		_ = msg.Ack()
		return
	}
	if err := s.DeliverKakaoOutbound(context.Background(), t); err != nil {
		if errors.Is(err, ErrInvalid) {
			_ = msg.Ack()
			return
		}
		_ = msg.Nak()
		return
	}
	_ = msg.Ack()
}

func (s *Service) handleOutbound(msg jetstream.Msg) {
	var t OutboundTask
	if err := json.Unmarshal(msg.Data(), &t); err != nil {
		_ = msg.Ack()
		return
	}
	if err := s.DeliverOutbound(context.Background(), t); err != nil {
		if errors.Is(err, ErrInvalid) {
			_ = msg.Ack()
			return
		}
		_ = msg.Nak()
		return
	}
	_ = msg.Ack()
}
