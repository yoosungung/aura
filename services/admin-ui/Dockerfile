# aura-admin-ui — Vite dist + nginx.conf baked (no dist ConfigMap).
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && test -f dist/aura-logo.jpg

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
COPY public/aura-logo.jpg /aura-logo.jpg
RUN test -s /aura-logo.jpg && test -s /usr/share/nginx/html/aura-logo.jpg
EXPOSE 8080
