import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const conf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "nginx.conf"), "utf8");

describe("nginx.conf", () => {
  it("proxies API, auth, and websocket to in-cluster gateway-web", () => {
    expect(conf).toMatch(/location \/api/);
    expect(conf).toMatch(/location \/auth/);
    expect(conf).toMatch(/location \/ws/);
    expect(conf).toContain("http://gateway-web.aura.svc.cluster.local:8080");
    expect(conf).toMatch(/proxy_set_header Upgrade/);
  });

  it("does not proxy widget source files", () => {
    expect(conf).not.toContain("widget\\.html");
    expect(conf).not.toMatch(/location \/src/);
  });
});
