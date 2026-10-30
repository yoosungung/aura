package routing_test

import (
	"context"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/yoosungung/aura/internal/routing"
	"github.com/yoosungung/aura/internal/testutil"
)

func TestCapacity_StopsAtMax(t *testing.T) {
	ctx := context.Background()
	js := testutil.NATS(t)
	kv, err := routing.EnsureKV(ctx, js)
	if err != nil {
		t.Fatal(err)
	}
	store := routing.Store{KV: kv}
	account, user := mustV7(t), mustV7(t)
	ok, err := store.TryAcquire(ctx, account, user, 1)
	if err != nil || !ok {
		t.Fatalf("first %v %v", ok, err)
	}
	ok, err = store.TryAcquire(ctx, account, user, 1)
	if err != nil || ok {
		t.Fatalf("second %v %v", ok, err)
	}
	if err := store.Release(ctx, account, user); err != nil {
		t.Fatal(err)
	}
	ok, err = store.TryAcquire(ctx, account, user, 1)
	if err != nil || !ok {
		t.Fatalf("after release %v %v", ok, err)
	}
}

func TestCapacity_ConcurrentOneWins(t *testing.T) {
	ctx := context.Background()
	js := testutil.NATS(t)
	kv, err := routing.EnsureKV(ctx, js)
	if err != nil {
		t.Fatal(err)
	}
	store := routing.Store{KV: kv}
	account, user := mustV7(t), mustV7(t)
	var won int
	var mu sync.Mutex
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := store.TryAcquire(ctx, account, user, 1)
			if err != nil {
				t.Errorf("%v", err)
				return
			}
			if ok {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if won != 1 {
		t.Fatalf("won=%d", won)
	}
}

func mustV7(t *testing.T) uuid.UUID {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
