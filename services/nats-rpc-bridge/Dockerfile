# aura-nats-rpc-bridge — nats deps baked in (no initContainer npm install).
# Build context is the repo root (deploy/scripts/build-nats-bridge-images.sh).
FROM node:22-alpine
WORKDIR /app
COPY services/nats-rpc-bridge/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY services/nats-rpc-bridge/bridge.js ./
COPY services/admin-ui/public/aura-logo.jpg /aura-logo.jpg
RUN test -s /aura-logo.jpg
USER node
CMD ["node", "bridge.js"]
