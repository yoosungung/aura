import assert from "node:assert/strict";
import test from "node:test";
import { decode, encode } from "./protocol.js";

test("decode accepts aura-widget envelopes only", () => {
  const msg = encode("ready", { height: 480 });
  assert.deepEqual(decode(msg), { event: "ready", payload: { height: 480 } });
  assert.equal(decode({ source: "other", event: "ready" }), null);
  assert.equal(decode("aura-widget:ready"), null);
  assert.equal(decode(null), null);
});
