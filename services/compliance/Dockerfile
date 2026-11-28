# aura/compliance-erase (Rust). Node parallel: services/compliance/Dockerfile → :node-local
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
COPY services/compliance ./services/compliance
RUN cargo build --release -p aura-compliance-erase

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /src/target/release/aura-compliance-erase /aura-compliance-erase
USER nonroot:nonroot
LABEL org.opencontainers.image.logo="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg" \
      dev.orbstack.icon="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg"
ENTRYPOINT ["/aura-compliance-erase"]
