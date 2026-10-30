package routing

import (
	"context"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"
)

const CapacityBucket = "AGENT_CAPACITY"

type Store struct {
	KV jetstream.KeyValue
}

func EnsureKV(ctx context.Context, js jetstream.JetStream) (jetstream.KeyValue, error) {
	return js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{Bucket: CapacityBucket})
}

func capKey(account, user uuid.UUID) string {
	return account.String() + "." + user.String()
}

func rrKey(account, inbox uuid.UUID) string {
	return account.String() + "." + inbox.String() + ".rr"
}

func (s Store) TryAcquire(ctx context.Context, account, user uuid.UUID, max int) (bool, error) {
	if max <= 0 {
		return false, nil
	}
	key := capKey(account, user)
	for range 8 {
		entry, err := s.KV.Get(ctx, key)
		if err != nil {
			if isMissing(err) {
				if _, err := s.KV.Create(ctx, key, []byte("1")); err != nil {
					if isConflict(err) {
						continue
					}
					return false, err
				}
				return true, nil
			}
			return false, err
		}
		n, err := strconv.Atoi(string(entry.Value()))
		if err != nil {
			return false, err
		}
		if n >= max {
			return false, nil
		}
		if _, err := s.KV.Update(ctx, key, []byte(strconv.Itoa(n+1)), entry.Revision()); err != nil {
			if isConflict(err) {
				continue
			}
			return false, err
		}
		return true, nil
	}
	return false, nil
}

func (s Store) Release(ctx context.Context, account, user uuid.UUID) error {
	key := capKey(account, user)
	for range 8 {
		entry, err := s.KV.Get(ctx, key)
		if err != nil {
			if isMissing(err) {
				return nil
			}
			return err
		}
		n, err := strconv.Atoi(string(entry.Value()))
		if err != nil {
			return err
		}
		if n <= 0 {
			return nil
		}
		if _, err := s.KV.Update(ctx, key, []byte(strconv.Itoa(n-1)), entry.Revision()); err != nil {
			if isConflict(err) {
				continue
			}
			return err
		}
		return nil
	}
	return nil
}

func (s Store) NextCursor(ctx context.Context, account, inbox uuid.UUID, n int) (int, error) {
	if n <= 0 {
		return 0, nil
	}
	key := rrKey(account, inbox)
	for range 8 {
		entry, err := s.KV.Get(ctx, key)
		if err != nil {
			if isMissing(err) {
				if _, err := s.KV.Create(ctx, key, []byte("1")); err != nil {
					if isConflict(err) {
						continue
					}
					return 0, err
				}
				return 0, nil
			}
			return 0, err
		}
		cur, err := strconv.Atoi(string(entry.Value()))
		if err != nil {
			return 0, err
		}
		next := cur + 1
		if _, err := s.KV.Update(ctx, key, []byte(strconv.Itoa(next)), entry.Revision()); err != nil {
			if isConflict(err) {
				continue
			}
			return 0, err
		}
		return cur % n, nil
	}
	return 0, nil
}

func isMissing(err error) bool {
	return err != nil && (err == jetstream.ErrKeyNotFound || strings.Contains(err.Error(), "not found"))
}

func isConflict(err error) bool {
	return err != nil && (err == jetstream.ErrKeyExists || strings.Contains(err.Error(), "wrong last sequence") || strings.Contains(err.Error(), "already exists"))
}
