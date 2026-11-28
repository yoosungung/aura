# Build from repo root.
FROM rust:1.94-bookworm AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY services/nats-rpc-bridge/rs ./services/nats-rpc-bridge/rs
COPY services/nats-task-bridge/rs ./services/nats-task-bridge/rs
COPY services/gateway/rs ./services/gateway/rs
COPY services/llm-gateway/rs ./services/llm-gateway/rs
COPY services/control/rs ./services/control/rs
COPY services/memory-capture/rs ./services/memory-capture/rs
COPY services/memory/rs ./services/memory/rs
COPY services/agent-invoke/rs ./services/agent-invoke/rs
COPY services/mcp-invoke/rs ./services/mcp-invoke/rs
RUN cargo build -p aura-nats-task-bridge --release

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /src/target/release/aura-nats-task-bridge /aura-nats-task-bridge
USER nonroot:nonroot
LABEL org.opencontainers.image.logo="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg" \
      dev.orbstack.icon="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg"
ENTRYPOINT ["/aura-nats-task-bridge"]
