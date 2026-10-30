import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("build emits host IIFE under 5KB without runtime imports", () => {
  const result = spawnSync(process.execPath, ["build.js"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const loaderPath = join(root, "aura-loader.min.js");
  const loader = readFileSync(loaderPath, "utf8");
  assert.ok(statSync(loaderPath).size < 5120);
  assert.doesNotMatch(loader, /\bfrom\s+["']\.\//);
  assert.doesNotMatch(loader, /\bimport\s+/);

  const sandbox = { window: {} };
  sandbox.window = sandbox;
  vm.runInNewContext(loader, sandbox);
  assert.equal(typeof sandbox.auraSDK.run, "function");

  const widget = readFileSync(join(root, "widget.min.js"), "utf8");
  assert.doesNotMatch(widget, /\bfrom\s+["']\.\//);
  assert.doesNotMatch(widget, /\bimport\s+/);

  const html = readFileSync(join(root, "widget.html"), "utf8");
  assert.match(html, /src=["']\.\/widget\.min\.js["']/);
  assert.doesNotMatch(html, /type=["']module["']/);
});
