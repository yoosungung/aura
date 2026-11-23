# aura-control-admin — admin HTTP + pg baked in (no source ConfigMap, no runtime npm install).
# Build context is the repo root so activate can require services/object-store/get-object.js.
FROM node:22-alpine
WORKDIR /app/services/control
COPY services/control/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY services/control/admin-entrypoint.js services/control/admin-server.js services/control/admin-http.js services/control/tenant-tx.js ./
COPY services/object-store/get-object.js /app/services/object-store/get-object.js
USER node
EXPOSE 8080
CMD ["node", "admin-entrypoint.js"]
LABEL org.opencontainers.image.logo="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg" \
      dev.orbstack.icon="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg"
