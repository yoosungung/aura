package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/gateway"
	"github.com/yoosungung/aura/internal/ingest"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	natsURL := getenv("AURA_NATS_URL", nats.DefaultURL)
	secret := []byte(os.Getenv("AURA_TOKEN_SECRET"))
	if len(secret) == 0 {
		log.Fatal("AURA_TOKEN_SECRET required")
	}
	addr := getenv("AURA_HTTP_ADDR", ":8080")

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

	n := gateway.NewRPC(nc)
	srv := &gateway.Server{
		Service: &gateway.Service{
			Secret:  secret,
			RPC:     n,
			Auth:    n,
			Members: n,
			Assign:  n,
			Notes:   n,
			Snooze:  n,
			Bus:     gateway.NewBus(nc, js),
		},
		NC: nc,
	}
	httpSrv := &http.Server{Addr: addr, Handler: srv.Handler()}
	go func() {
		<-ctx.Done()
		_ = httpSrv.Shutdown(context.Background())
	}()
	log.Printf("gateway-web listening on %s", addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
