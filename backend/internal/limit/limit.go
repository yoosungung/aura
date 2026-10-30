package limit

import (
	"errors"
	"sync"
	"time"
)

var (
	ErrRateLimited = errors.New("rate_limited")
	ErrCircuitOpen = errors.New("circuit_open")
)

type tokenBucket struct {
	mu     sync.Mutex
	rate   float64
	burst  float64
	tokens float64
	last   time.Time
}

func (b *tokenBucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	if b.last.IsZero() {
		b.last = now
		b.tokens = b.burst
	}
	elapsed := now.Sub(b.last).Seconds()
	b.tokens += elapsed * b.rate
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

type Breaker struct {
	mu        sync.Mutex
	failures  int
	threshold int
	openFor   time.Duration
	openedAt  time.Time
	halfOpen  bool
}

func NewBreaker(channel string, threshold int, openFor time.Duration) *Breaker {
	_ = channel
	if threshold < 1 {
		threshold = 5
	}
	if openFor <= 0 {
		openFor = 30 * time.Second
	}
	return &Breaker{threshold: threshold, openFor: openFor}
}

func (b *Breaker) Allow() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failures < b.threshold {
		return nil
	}
	if time.Since(b.openedAt) < b.openFor && !b.halfOpen {
		return ErrCircuitOpen
	}
	b.halfOpen = true
	return nil
}

func (b *Breaker) Failure() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failures++
	if b.failures >= b.threshold {
		b.openedAt = time.Now()
		b.halfOpen = false
	}
}

func (b *Breaker) Success() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failures = 0
	b.halfOpen = false
}

type Limiter struct {
	bucket *tokenBucket
}

func New(channel string, rps, burst int) *Limiter {
	_ = channel
	if rps < 1 {
		rps = 20
	}
	if burst < 1 {
		burst = rps * 2
	}
	return &Limiter{bucket: &tokenBucket{rate: float64(rps), burst: float64(burst), tokens: float64(burst), last: time.Now()}}
}

func (l *Limiter) Allow() error {
	if !l.bucket.allow() {
		return ErrRateLimited
	}
	return nil
}

type Guard struct {
	mu       sync.Mutex
	limiters map[string]*Limiter
	breakers map[string]*Breaker
	rps      int
	burst    int
	fails    int
	openFor  time.Duration
}

func DefaultGuard() *Guard {
	return NewGuard(20, 40, 5, 30*time.Second)
}

func NewGuard(rps, burst, fails int, openFor time.Duration) *Guard {
	if rps < 1 {
		rps = 20
	}
	if burst < 1 {
		burst = 40
	}
	if fails < 1 {
		fails = 5
	}
	if openFor <= 0 {
		openFor = 30 * time.Second
	}
	return &Guard{
		limiters: map[string]*Limiter{},
		breakers: map[string]*Breaker{},
		rps:      rps,
		burst:    burst,
		fails:    fails,
		openFor:  openFor,
	}
}

func (g *Guard) channel(ch string) (*Limiter, *Breaker) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if ch == "" {
		ch = "web"
	}
	l, ok := g.limiters[ch]
	if !ok {
		l = New(ch, g.rps, g.burst)
		g.limiters[ch] = l
	}
	b, ok := g.breakers[ch]
	if !ok {
		b = NewBreaker(ch, g.fails, g.openFor)
		g.breakers[ch] = b
	}
	return l, b
}

func (g *Guard) Allow(channel string) error {
	l, b := g.channel(channel)
	if err := b.Allow(); err != nil {
		return err
	}
	return l.Allow()
}

func (g *Guard) Success(channel string) {
	_, b := g.channel(channel)
	b.Success()
}

func (g *Guard) Failure(channel string) {
	_, b := g.channel(channel)
	b.Failure()
}
