import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function parseArgs(argv) {
  const [resource, action, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (!tok.startsWith("--")) {
      continue;
    }
    const key = tok.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { resource, action, flags };
}

export function loadDotEnv(dir) {
  const file = join(dir, ".env");
  if (existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const eq = line.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
  return {
    gatewayUrl: process.env.AURA_GATEWAY_URL || "http://127.0.0.1:8080",
    platformToken: process.env.AURA_PLATFORM_TOKEN || "",
  };
}

export function buildRequest(env, parsed) {
  if (!env?.platformToken) {
    throw new Error("AURA_PLATFORM_TOKEN is required");
  }
  const base = String(env.gatewayUrl || "http://127.0.0.1:8080").replace(/\/$/, "");
  const flags = parsed.flags || {};
  const resource = parsed.resource;
  const action = parsed.action;
  if (resource === "accounts") {
    return accountRequest(base, env.platformToken, action, flags);
  }
  if (resource === "users") {
    return userRequest(base, env.platformToken, action, flags);
  }
  throw new Error(`unknown resource ${resource}`);
}

function accountRequest(base, token, action, flags) {
  if (action === "create") {
    return jsonReq("POST", `${base}/platform/api/v1/accounts`, token, {
      name: flags.name,
      locale: flags.locale,
      user: {
        name: flags["user-name"],
        email: flags.email,
        password: flags.password,
      },
    });
  }
  if (action === "list") {
    return rawReq("GET", `${base}/platform/api/v1/accounts`, token);
  }
  if (action === "update") {
    requireFlag(flags, "id");
    const body = {};
    if (flags.name !== undefined) {
      body.name = flags.name;
    }
    if (flags.locale !== undefined) {
      body.locale = flags.locale;
    }
    return jsonReq("PATCH", `${base}/platform/api/v1/accounts/${flags.id}`, token, body);
  }
  if (action === "delete") {
    requireFlag(flags, "id");
    return rawReq("DELETE", `${base}/platform/api/v1/accounts/${flags.id}`, token);
  }
  throw new Error(`unknown action ${action}`);
}

function userRequest(base, token, action, flags) {
  if (action === "create") {
    return jsonReq("POST", `${base}/platform/api/v1/users`, token, {
      account_id: flags["account-id"],
      name: flags.name,
      email: flags.email,
      password: flags.password,
      role: flags.role,
    });
  }
  if (action === "list") {
    requireFlag(flags, "account-id");
    const q = new URLSearchParams({ account_id: flags["account-id"] });
    return rawReq("GET", `${base}/platform/api/v1/users?${q}`, token);
  }
  if (action === "update") {
    requireFlag(flags, "id");
    const body = {};
    for (const key of ["name", "email", "password", "role"]) {
      if (flags[key] !== undefined) {
        body[key] = flags[key];
      }
    }
    if (flags["account-id"] !== undefined) {
      body.account_id = flags["account-id"];
    }
    return jsonReq("PATCH", `${base}/platform/api/v1/users/${flags.id}`, token, body);
  }
  if (action === "delete") {
    requireFlag(flags, "id");
    return rawReq("DELETE", `${base}/platform/api/v1/users/${flags.id}`, token);
  }
  throw new Error(`unknown action ${action}`);
}

function requireFlag(flags, key) {
  if (!flags[key]) {
    throw new Error(`--${key} is required`);
  }
}

function rawReq(method, url, token) {
  return {
    method,
    url,
    headers: { Authorization: `Bearer ${token}` },
  };
}

function jsonReq(method, url, token, body) {
  return {
    method,
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}
