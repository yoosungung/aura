import { createLoader } from "./src/loader.js";

export function run(opts) {
  return createLoader(window, opts);
}

if (typeof window !== "undefined") {
  window.auraSDK = { run };
}
