import { createFrame } from "./src/frame.js";

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
