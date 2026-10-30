package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/archive"
	"github.com/yoosungung/aura/internal/ingest"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	natsURL := getenv("AURA_NATS_URL", nats.DefaultURL)
	filer := strings.TrimRight(getenv("AURA_FILER_URL", "http://127.0.0.1:8888"), "/")
	nc, err := nats.Connect(natsURL)
	if err != nil {
		log.Fatal(err)
	}
	defer nc.Drain()
	js, err := jetstream.New(nc)
	if err != nil {
		log.Fatal(err)
	}
	if _, err := ingest.EnsureStreams(ctx, js); err != nil {
		log.Fatal(err)
	}
	w := &archive.Worker{
		JS: js,
		Store: archive.FilerStore{
			GetFn: func(ctx context.Context, key string) ([]byte, error) {
				req, err := http.NewRequestWithContext(ctx, http.MethodGet, filer+"/"+key, nil)
				if err != nil {
					return nil, err
				}
				res, err := http.DefaultClient.Do(req)
				if err != nil {
					return nil, err
				}
				defer res.Body.Close()
				if res.StatusCode == http.StatusNotFound {
					return nil, archive.ErrNotFound
				}
				if res.StatusCode >= 300 {
					_, _ = io.Copy(io.Discard, res.Body)
					return nil, fmt.Errorf("filer %d", res.StatusCode)
				}
				return io.ReadAll(res.Body)
			},
			PutFn: func(ctx context.Context, key string, body []byte) error {
				req, err := http.NewRequestWithContext(ctx, http.MethodPut, filer+"/"+key, bytes.NewReader(body))
				if err != nil {
					return err
				}
				req.Header.Set("Content-Type", "application/x-ndjson")
				res, err := http.DefaultClient.Do(req)
				if err != nil {
					return err
				}
				defer res.Body.Close()
				_, _ = io.Copy(io.Discard, res.Body)
				if res.StatusCode >= 300 {
					return fmt.Errorf("filer %d", res.StatusCode)
				}
				return nil
			},
		},
	}
	log.Print("event-archive running")
	if err := w.Consume(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
