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
	"github.com/yoosungung/aura/internal/limit"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	natsURL := getenv("AURA_NATS_URL", nats.DefaultURL)
	addr := getenv("AURA_KAKAO_ADDR", ":8081")

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
		RPC:         n,
		Kakao:       n,
		Bus:         gateway.NewBus(nc, js),
		JS:          js,
		Guard:       limit.DefaultGuard(),
		KakaoSender: gateway.KakaoHub{BaseURL: os.Getenv("AURA_KAKAO_API_URL"), Token: os.Getenv("AURA_KAKAO_API_KEY")},
	}
	srv := &gateway.Server{Service: svc, NC: nc}
	go func() {
		if err := svc.ConsumeKakaoOutbound(ctx); err != nil && ctx.Err() == nil {
			log.Print(err)
		}
	}()
	httpSrv := &http.Server{Addr: addr, Handler: srv.KakaoHandler()}
	go func() {
		<-ctx.Done()
		_ = httpSrv.Shutdown(context.Background())
	}()
	log.Printf("gateway-kakao listening on %s", addr)
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
