# aura-nats-task-bridge — nats deps baked in (no initContainer npm install).
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY bridge.js ./
USER node
CMD ["node", "bridge.js"]
