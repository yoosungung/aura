# aura-llm-gateway — gateway.js baked (stub provider default; no node -e stub).
FROM node:22-alpine
WORKDIR /app
COPY package.json gateway.js client.js entrypoint.js ./
USER node
EXPOSE 8080
CMD ["node", "entrypoint.js"]
LABEL org.opencontainers.image.logo="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg" \
      dev.orbstack.icon="https://raw.githubusercontent.com/yoosungung/aura/main/services/admin-ui/public/aura-logo.jpg"
