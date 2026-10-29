package gateway_test

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/gateway"
)

func TestParse_RequiresExpAndSid(t *testing.T) {
	tok := gateway.Token{Kind: gateway.KindUser, AccountID: mustV7(t), UserID: mustV7(t)}
	signed := mustSign(t, tok)
	got, err := gateway.Parse(secret, signed)
	if err != nil {
		t.Fatal(err)
	}
	if got.Exp == 0 || got.Sid == uuid.Nil {
		t.Fatalf("sign should fill exp/sid: %+v", got)
	}

	expired := tok
	expired.Exp = time.Now().Add(-time.Minute).Unix()
	expired.Sid = mustV7(t)
	bad, err := gateway.Sign(secret, expired)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gateway.Parse(secret, bad); err == nil {
		t.Fatal("expected expired token to fail")
	}
}
