import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../widget.html"), "utf8");

test("widget.html chrome matches layout §4", () => {
  assert.match(html, /💬 Aura 고객센터/);
  assert.match(html, /보통 5분 내 응답합니다/);
  assert.match(html, /id="messages"/);
  assert.match(html, /role="log"/);
  assert.match(html, /header[^}]*height:\s*56px/);
  assert.match(html, /#composer[^}]*height:\s*60px/);
  assert.match(html, /Pretendard/);
  assert.match(html, /aria-label="닫기"/);
  assert.match(html, /aria-label="메시지를 입력하세요"/);
  assert.match(html, /data-sender="Contact"/);
  assert.match(html, /data-sender="User"/);
  assert.match(html, /li\.csat|#messages li\[data-csat/);
});
