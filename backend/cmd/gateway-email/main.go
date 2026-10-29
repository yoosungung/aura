package main

import (
	"context"
	"log"
	"net"
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
	addr := getenv("AURA_SMTP_ADDR", ":25")
	filer := getenv("AURA_FILER_URL", "http://127.0.0.1:8888")
	public := getenv("AURA_FILER_PUBLIC_URL", filer)

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
	svc := &gateway.Service{
		RPC:   n,
		Email: n,
		Bus:   gateway.NewBus(nc, js),
		Blobs: &gateway.FilerStore{Endpoint: filer, Public: public},
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("gateway-email listening on %s", addr)
	if err := svc.ServeSMTP(ctx, ln); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
