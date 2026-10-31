import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
  },
  server: {
    proxy: {
      "/auth": "http://127.0.0.1:30080",
      "/api": "http://127.0.0.1:30080",
      "/ws": { target: "ws://127.0.0.1:30080", ws: true },
    },
  },
});
