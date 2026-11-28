# Phase 0 distroless template for platform Rust binaries.
# Build from repo root:
#   docker build -f crates/aura-nats-smoke/Dockerfile -t aura/nats-smoke:local .

FROM rust:1.94-bookworm AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY services/nats-rpc-bridge ./services/nats-rpc-bridge
COPY services/nats-task-bridge ./services/nats-task-bridge
RUN cargo build -p aura-nats-smoke --release

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /src/target/release/aura-nats-smoke /aura-nats-smoke
USER nonroot:nonroot
ENTRYPOINT ["/aura-nats-smoke"]
