# syntax=docker/dockerfile:1
FROM rust:1.94-bookworm AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY services/nats-rpc-bridge ./services/nats-rpc-bridge
COPY services/nats-task-bridge ./services/nats-task-bridge
COPY services/gateway ./services/gateway
COPY services/llm-gateway ./services/llm-gateway
COPY services/control ./services/control
COPY services/memory ./services/memory
RUN cargo build --release -p aura-control

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /src/target/release/aura-control-admin /aura-control-admin
USER nonroot
EXPOSE 8080
LABEL org.opencontainers.image.logo="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg" \
      dev.orbstack.icon="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg"
ENTRYPOINT ["/aura-control-admin"]
