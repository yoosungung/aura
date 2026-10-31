#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRequest, loadDotEnv, parseArgs } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const usage = `usage: node deploy/operator/aura.mjs <accounts|users> <create|list|update|delete> [flags]

accounts create --name NAME --locale ko --user-name NAME --email EMAIL --password PASS
accounts list
accounts update --id ID [--name NAME] [--locale ko]
accounts delete --id ID

users create --account-id ID --name NAME --email EMAIL --password PASS [--role agent]
users list --account-id ID
users update --id ID [--name NAME] [--email EMAIL] [--password PASS] [--role agent] [--account-id ID]
users delete --id ID

env: AURA_PLATFORM_TOKEN, AURA_GATEWAY_URL (default http://127.0.0.1:8080)
     or deploy/operator/.env
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stderr.write(usage);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  let env = loadDotEnv(process.cwd());
  if (!env.platformToken) {
    env = loadDotEnv(here);
  }
  const req = buildRequest(env, parseArgs(argv));
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  const text = await res.text();
  if (text) {
    try {
      process.stdout.write(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    } catch {
      process.stdout.write(`${text}\n`);
    }
  }
  if (!res.ok) {
    process.stderr.write(`${req.method} ${req.url} → ${res.status}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
