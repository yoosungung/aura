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
