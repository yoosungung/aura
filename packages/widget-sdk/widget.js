import { createFrame } from "./src/frame.js";
import { encode } from "./src/protocol.js";

const frame = createFrame(window);
const form = document.getElementById("composer");
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = form.elements.namedItem("content");
  const content = input.value.trim();
  if (!content) {
    return;
  }
  input.value = "";
  frame.send(content).catch(() => {});
});
document.getElementById("close")?.addEventListener("click", () => {
  const parent = new URLSearchParams(window.location.search).get("parent_origin");
  if (parent) {
    window.parent.postMessage(encode("close"), parent);
  }
});
document.getElementById("help")?.addEventListener("click", () => {
  const panel = document.getElementById("help-panel");
  if (panel) {
    panel.hidden = !panel.hidden;
  }
});
document.getElementById("help-search")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.namedItem("q");
  frame.searchHelp(input?.value || "").catch(() => {});
});
