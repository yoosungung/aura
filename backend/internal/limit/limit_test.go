package limit

import (
	"errors"
	"testing"
	"time"
)

func TestLimiter_AllowsBurstThenBlocks(t *testing.T) {
	l := New("email", 2, 2)
	if err := l.Allow(); err != nil {
		t.Fatal(err)
	}
	if err := l.Allow(); err != nil {
		t.Fatal(err)
	}
	if err := l.Allow(); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("got %v", err)
	}
}

func TestBreaker_OpensAfterFailures(t *testing.T) {
	b := NewBreaker("kakao", 2, 50*time.Millisecond)
	if err := b.Allow(); err != nil {
		t.Fatal(err)
	}
	b.Failure()
	b.Failure()
	if err := b.Allow(); !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("got %v", err)
	}
	time.Sleep(60 * time.Millisecond)
	if err := b.Allow(); err != nil {
		t.Fatal(err)
	}
	b.Success()
	if err := b.Allow(); err != nil {
		t.Fatal(err)
	}
}

func TestGuard_PerChannel(t *testing.T) {
	g := NewGuard(10, 10, 3, time.Second)
	if err := g.Allow("web"); err != nil {
		t.Fatal(err)
	}
	g.Failure("email")
	g.Failure("email")
	g.Failure("email")
	if err := g.Allow("email"); !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("email %v", err)
	}
	if err := g.Allow("web"); err != nil {
		t.Fatalf("web %v", err)
	}
}
