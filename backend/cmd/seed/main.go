package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/yoosungung/aura/internal/core"
	"github.com/yoosungung/aura/internal/migrate"
)

func main() {
	ctx := context.Background()
	dsn := getenv("AURA_MIGRATE_DSN", "postgres://aura:aura@127.0.0.1:5432/aura?sslmode=disable")

	var pool *pgxpool.Pool
	var err error
	deadline := time.Now().Add(2 * time.Minute)
	for {
		pool, err = pgxpool.New(ctx, dsn)
		if err == nil {
			pingErr := pool.Ping(ctx)
			if pingErr == nil {
				break
			}
			err = pingErr
			pool.Close()
		}
		if time.Now().After(deadline) {
			log.Fatal(err)
		}
		time.Sleep(2 * time.Second)
	}
	defer pool.Close()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		log.Fatal(err)
	}
	if err := migrate.Up(ctx, conn.Conn()); err != nil {
		conn.Release()
		log.Fatal(err)
	}
	conn.Release()

	out, skipped, err := core.SeedDevLogin(ctx, pool)
	if err != nil {
		log.Fatal(err)
	}
	if skipped {
		log.Printf("seed skipped email=%s account=%s", core.DevSeedEmail, out.AccountID)
		return
	}
	log.Printf("seed created email=%s account=%s user=%s", core.DevSeedEmail, out.AccountID, out.UserID)
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
