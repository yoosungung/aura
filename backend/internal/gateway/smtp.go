package gateway

import (
	"context"
	"errors"
	"io"
	"net"

	"github.com/emersion/go-smtp"
	"github.com/yoosungung/aura/internal/core"
)

type smtpBackend struct {
	svc *Service
}

func (b *smtpBackend) NewSession(_ *smtp.Conn) (smtp.Session, error) {
	return &smtpSession{svc: b.svc}, nil
}

type smtpSession struct {
	svc  *Service
	from string
	rcpt []string
}

func (s *smtpSession) Mail(from string, _ *smtp.MailOptions) error {
	s.from = from
	return nil
}

func (s *smtpSession) Rcpt(to string, _ *smtp.RcptOptions) error {
	s.rcpt = append(s.rcpt, to)
	return nil
}

func (s *smtpSession) Data(r io.Reader) error {
	raw, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	err = s.svc.AcceptEmail(context.Background(), raw, s.from, s.rcpt)
	if err == nil {
		return nil
	}
	if errors.Is(err, core.ErrNotFound) || errors.Is(err, ErrInvalid) || err.Error() == core.ErrNotFound.Error() {
		return &smtp.SMTPError{
			Code: 550, EnhancedCode: smtp.EnhancedCode{5, 1, 1}, Message: "unknown recipient",
		}
	}
	return &smtp.SMTPError{
		Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "temporary failure",
	}
}

func (s *smtpSession) Reset() {
	s.from = ""
	s.rcpt = nil
}

func (s *smtpSession) Logout() error {
	return nil
}

func (s *Service) ServeSMTP(ctx context.Context, ln net.Listener) error {
	srv := smtp.NewServer(&smtpBackend{svc: s})
	srv.Domain = "aura"
	srv.AllowInsecureAuth = true
	srv.MaxMessageBytes = 25 << 20
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	err := srv.Serve(ln)
	if errors.Is(err, smtp.ErrServerClosed) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}
