import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const frontendRoot = process.cwd();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") {
      continue;
    }
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...walk(p));
      continue;
    }
    if (/\.(js|jsx)$/.test(name)) {
      out.push(relative(frontendRoot, p));
    }
  }
  return out.sort();
}

test("frontend has no leftover JavaScript sources", () => {
  expect(walk(frontendRoot)).toEqual([]);
});
