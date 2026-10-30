import * as esbuild from "esbuild";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const absWorkingDir = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  absWorkingDir,
  entryPoints: ["sdk.js"],
  outfile: "aura-loader.min.js",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  globalName: "auraSDK",
  legalComments: "none",
});

await esbuild.build({
  absWorkingDir,
  entryPoints: ["widget.js"],
  outfile: "widget.min.js",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  legalComments: "none",
});
