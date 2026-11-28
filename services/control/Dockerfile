# aura-control-admin — live Pooler + RustFS (admin-ui.md).
# Build context = repo root so activate/presign can require services/object-store/get-object.js.
# Rust resolve remains Dockerfile.resolve; admin live S3/Pooler stays Node until Rust sqlx canary.
FROM node:22-alpine
WORKDIR /app/services/control
COPY services/control/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY services/control/admin-entrypoint.js \
     services/control/admin-server.js \
     services/control/admin-http.js \
     services/control/tenant-tx.js ./
COPY services/object-store/get-object.js /app/services/object-store/get-object.js
USER node
EXPOSE 8080
CMD ["node", "admin-entrypoint.js"]
LABEL org.opencontainers.image.logo="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg" \
      dev.orbstack.icon="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg"
