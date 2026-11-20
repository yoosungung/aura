# aura-control-admin — admin HTTP + pg baked in (no source ConfigMap, no runtime npm install).
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY admin-entrypoint.js admin-server.js admin-http.js tenant-tx.js ./
USER node
EXPOSE 8080
CMD ["node", "admin-entrypoint.js"]
LABEL org.opencontainers.image.logo="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg" \
      dev.orbstack.icon="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg"
