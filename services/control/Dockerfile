# aura-control-admin — admin HTTP + pg baked in (no source ConfigMap, no runtime npm install).
# Build context is the repo root (deploy/scripts/build-admin-images.sh).
FROM node:22-alpine
WORKDIR /app
COPY services/control/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY services/control/admin-entrypoint.js services/control/admin-server.js services/control/admin-http.js services/control/tenant-tx.js ./
COPY services/admin-ui/public/aura-logo.jpg /aura-logo.jpg
RUN test -s /aura-logo.jpg
USER node
EXPOSE 8080
CMD ["node", "admin-entrypoint.js"]
