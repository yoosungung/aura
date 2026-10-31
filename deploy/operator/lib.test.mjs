import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRequest, loadDotEnv, parseArgs } from "./lib.mjs";

test("parseArgs reads resource action and flags", () => {
  const got = parseArgs(["accounts", "create", "--name", "pilot", "--locale", "ko"]);
  assert.equal(got.resource, "accounts");
  assert.equal(got.action, "create");
  assert.equal(got.flags.name, "pilot");
  assert.equal(got.flags.locale, "ko");
});

test("account create uses platform token POST", () => {
  const req = buildRequest(
    { gatewayUrl: "http://127.0.0.1:8080", platformToken: "plat" },
    parseArgs([
      "accounts",
      "create",
      "--name",
      "pilot",
      "--locale",
      "ko",
      "--user-name",
      "Ada",
      "--email",
      "ada@pilot.test",
      "--password",
      "s3cret",
    ]),
  );
  assert.equal(req.method, "POST");
  assert.equal(req.url, "http://127.0.0.1:8080/platform/api/v1/accounts");
  assert.equal(req.headers.Authorization, "Bearer plat");
  assert.deepEqual(JSON.parse(req.body), {
    name: "pilot",
    locale: "ko",
    user: { name: "Ada", email: "ada@pilot.test", password: "s3cret" },
  });
});

test("user create uses platform token POST", () => {
  const req = buildRequest(
    { gatewayUrl: "http://127.0.0.1:8080", platformToken: "plat" },
    parseArgs([
      "users",
      "create",
      "--account-id",
      "acc-1",
      "--name",
      "Ada",
      "--email",
      "ada@pilot.test",
      "--password",
      "s3cret",
      "--role",
      "agent",
    ]),
  );
  assert.equal(req.method, "POST");
  assert.equal(req.url, "http://127.0.0.1:8080/platform/api/v1/users");
  assert.equal(req.headers.Authorization, "Bearer plat");
  assert.deepEqual(JSON.parse(req.body), {
    account_id: "acc-1",
    name: "Ada",
    email: "ada@pilot.test",
    password: "s3cret",
    role: "agent",
  });
});

test("account and user list update delete use platform paths", () => {
  const env = { gatewayUrl: "http://gw", platformToken: "plat" };
  const listAcct = buildRequest(env, parseArgs(["accounts", "list"]));
  assert.equal(listAcct.method, "GET");
  assert.equal(listAcct.url, "http://gw/platform/api/v1/accounts");
  const patchAcct = buildRequest(env, parseArgs(["accounts", "update", "--id", "a1", "--name", "n"]));
  assert.equal(patchAcct.method, "PATCH");
  assert.equal(patchAcct.url, "http://gw/platform/api/v1/accounts/a1");
  const delAcct = buildRequest(env, parseArgs(["accounts", "delete", "--id", "a1"]));
  assert.equal(delAcct.method, "DELETE");
  assert.equal(delAcct.url, "http://gw/platform/api/v1/accounts/a1");
  const listUsers = buildRequest(env, parseArgs(["users", "list", "--account-id", "a1"]));
  assert.equal(listUsers.method, "GET");
  assert.equal(listUsers.url, "http://gw/platform/api/v1/users?account_id=a1");
  const patchUser = buildRequest(env, parseArgs(["users", "update", "--id", "u1", "--name", "n"]));
  assert.equal(patchUser.method, "PATCH");
  assert.equal(patchUser.url, "http://gw/platform/api/v1/users/u1");
  const delUser = buildRequest(env, parseArgs(["users", "delete", "--id", "u1"]));
  assert.equal(delUser.method, "DELETE");
  assert.equal(delUser.url, "http://gw/platform/api/v1/users/u1");
});

test("buildRequest refuses missing platform token", () => {
  assert.throws(
    () => buildRequest({ gatewayUrl: "http://gw", platformToken: "" }, parseArgs(["accounts", "list"])),
    /AURA_PLATFORM_TOKEN/,
  );
});

test("loadDotEnv fills unset keys from file", () => {
  const dir = mkdtempSync(join(tmpdir(), "aura-op-"));
  writeFileSync(join(dir, ".env"), "AURA_PLATFORM_TOKEN=fromfile\nAURA_GATEWAY_URL=http://env\n");
  const prevToken = process.env.AURA_PLATFORM_TOKEN;
  const prevUrl = process.env.AURA_GATEWAY_URL;
  delete process.env.AURA_PLATFORM_TOKEN;
  delete process.env.AURA_GATEWAY_URL;
  try {
    const env = loadDotEnv(dir);
    assert.equal(env.platformToken, "fromfile");
    assert.equal(env.gatewayUrl, "http://env");
  } finally {
    if (prevToken === undefined) {
      delete process.env.AURA_PLATFORM_TOKEN;
    } else {
      process.env.AURA_PLATFORM_TOKEN = prevToken;
    }
    if (prevUrl === undefined) {
      delete process.env.AURA_GATEWAY_URL;
    } else {
      process.env.AURA_GATEWAY_URL = prevUrl;
    }
  }
});
