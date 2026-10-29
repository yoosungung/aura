import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedOrigin, parseHelpdeskOrigin, widgetSrc } from "./origin.js";

test("parseHelpdeskOrigin keeps http(s) origin only", () => {
  assert.equal(
    parseHelpdeskOrigin("https://help.example/app?x=1"),
    "https://help.example",
  );
  assert.throws(() => parseHelpdeskOrigin("javascript:alert(1)"));
  assert.throws(() => parseHelpdeskOrigin("data:text/html,hi"));
});

test("isAllowedOrigin does not use the host page origin", () => {
  const helpdesk = "https://help.example";
  const shop = "https://shop.example";
  assert.equal(isAllowedOrigin(helpdesk, helpdesk), true);
  assert.equal(isAllowedOrigin(shop, helpdesk), false);
  assert.equal(isAllowedOrigin("", helpdesk), false);
});

test("widgetSrc never embeds a token", () => {
  const src = widgetSrc("https://help.example/base", "https://shop.example");
  const url = new URL(src);
  assert.equal(url.origin, "https://help.example");
  assert.equal(url.pathname, "/widget.html");
  assert.equal(url.searchParams.get("parent_origin"), "https://shop.example");
  assert.equal(url.searchParams.get("token"), null);
});
