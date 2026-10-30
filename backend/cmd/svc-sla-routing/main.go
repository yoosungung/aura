package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/migrate"
	"github.com/yoosungung/aura/internal/routing"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	migrateDSN := getenv("AURA_MIGRATE_DSN", "postgres://aura:aura@127.0.0.1:5432/aura?sslmode=disable")
	dsn := getenv("AURA_DSN", "postgres://aura_app:aura_app@127.0.0.1:5432/aura?sslmode=disable")
	natsURL := getenv("AURA_NATS_URL", nats.DefaultURL)

	admin, err := pgxpool.New(ctx, migrateDSN)
	if err != nil {
		log.Fatal(err)
	}
	defer admin.Close()
	conn, err := admin.Acquire(ctx)
	if err != nil {
		log.Fatal(err)
	}
	if err := migrate.Up(ctx, conn.Conn()); err != nil {
		conn.Release()
		log.Fatal(err)
	}
	conn.Release()

	app, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer app.Close()

	nc, err := nats.Connect(natsURL)
	if err != nil {
		log.Fatal(err)
	}
	defer nc.Drain()
	js, err := jetstream.New(nc)
	if err != nil {
		log.Fatal(err)
	}
	kv, err := routing.EnsureKV(ctx, js)
	if err != nil {
		log.Fatal(err)
	}

	svc := &routing.Service{
		DB:       app,
		Capacity: routing.Store{KV: kv},
		Assigner: &core.Service{DB: app, JS: js},
	}
	log.Print("svc-sla-routing running")
	if err := svc.Consume(ctx, js); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
