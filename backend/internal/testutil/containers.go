package testutil

import (
	"context"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
	"github.com/yoosungung/aura/internal/migrate"
)

func Postgres(t *testing.T) (admin *pgx.Conn, app *pgx.Conn) {
	t.Helper()
	ctx := context.Background()
	ctr, err := postgres.Run(ctx,
		"pgvector/pgvector:0.8.7-pg16",
		postgres.WithDatabase("aura"),
		postgres.WithUsername("aura"),
		postgres.WithPassword("aura"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		t.Fatalf("postgres: %v", err)
	}
	t.Cleanup(func() { _ = ctr.Terminate(ctx) })

	dsn, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	admin, err = pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close(ctx) })
	if err := migrate.Up(ctx, admin); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.User = url.UserPassword("aura_app", "aura_app")
	app, err = pgx.Connect(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close(ctx) })
	return admin, app
}

func NATS(t *testing.T) jetstream.JetStream {
	t.Helper()
	ctx := context.Background()
	ctr, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "nats:2.15-alpine",
			ExposedPorts: []string{"4222/tcp"},
			Cmd:          []string{"-js", "-sd", "/data", "-m", "8222"},
			WaitingFor:   wait.ForListeningPort("4222/tcp").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	if err != nil {
		t.Fatalf("nats: %v", err)
	}
	t.Cleanup(func() { _ = ctr.Terminate(ctx) })
	host, err := ctr.Host(ctx)
	if err != nil {
		t.Fatal(err)
	}
	port, err := ctr.MappedPort(ctx, "4222/tcp")
	if err != nil {
		t.Fatal(err)
	}
	nc, err := nats.Connect(fmt.Sprintf("nats://%s:%s", host, port.Port()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { nc.Close() })
	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatal(err)
	}
	return js
}
