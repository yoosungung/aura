import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const conf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vite.config.ts"), "utf8");

describe("vite.config", () => {
  it("proxies auth, api, and websocket to the cluster frontend NodePort", () => {
    expect(conf).toContain('"/auth": "http://127.0.0.1:30080"');
    expect(conf).toContain('"/api": "http://127.0.0.1:30080"');
    expect(conf).toContain('target: "ws://127.0.0.1:30080"');
  });
});
