# syntax=docker/dockerfile:1
# Library crate — compile-check image for shadow/canary (Function entry wired later).
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
RUN cargo build --release -p aura-memory && touch /ok

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /ok /ok
USER nonroot
