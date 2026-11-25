# aura-admin-ui — Vite dist + nginx.conf baked (no dist ConfigMap).
# Build from repo root: docker build -f services/admin-ui/Dockerfile -t aura/admin-ui:local .
FROM node:22-alpine AS build
WORKDIR /src
COPY services/admin-ui/package.json services/admin-ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/admin-ui/ ./
COPY scaffolds /tmp/scaffolds-sot
ENV AURA_SCAFFOLDS_SOT=/tmp/scaffolds-sot
RUN node scripts/sync-scaffolds.cjs --from /tmp/scaffolds-sot
RUN npm run build \
  && test -f dist/aura-logo.jpg \
  && test -f dist/scaffolds/agent-nodejs/main.js \
  && test -f dist/scaffolds/mcp-python/main.py

FROM nginx:1.27-alpine
COPY services/admin-ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 8080
LABEL org.opencontainers.image.logo="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg" \
      dev.orbstack.icon="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg"
