'use strict';

/**
 * Build deploy/k8s/mcp-invoke/invoke.js + package.yaml literal from handler + streamable-http.
 * Fission Package is single-file (no require siblings).
 */

const fs = require('fs');
const path = require('path');

const root = __dirname;
const repoRoot = path.join(root, '../..');

const streamableSrc = fs.readFileSync(path.join(root, 'streamable-http.js'), 'utf8');
const streamableBody = streamableSrc
  .replace(/^'use strict';\n/, '')
  .replace(/\nmodule\.exports[\s\S]*$/, '\n');

let handlerSrc = fs.readFileSync(path.join(root, 'handler.js'), 'utf8');
handlerSrc = handlerSrc.replace(
  "const { callToolViaStreamableHttp } = require('./streamable-http');\n",
  '',
);

const header = `'use strict';

/**
 * Fission Package entry for mcp_invoke (ARCHITECTURE §1 #10·#11·#12 · §3.2 · §3.3).
 * Source of truth: services/mcp-invoke/handler.js + streamable-http.js
 * Single-file literal (streamable-http inlined). PG forbidden.
 */

`;

const invoke = header + streamableBody + handlerSrc;

const invokePath = path.join(repoRoot, 'deploy/k8s/mcp-invoke/invoke.js');
fs.writeFileSync(invokePath, invoke);

const b64 = Buffer.from(invoke, 'utf8').toString('base64');
const pkgPath = path.join(repoRoot, 'deploy/k8s/mcp-invoke/package.yaml');
let pkg = fs.readFileSync(pkgPath, 'utf8');
if (!/literal:\s*\S+/.test(pkg)) {
  throw new Error('package.yaml missing literal');
}
pkg = pkg.replace(/literal:\s*\S+/, `literal: ${b64}`);
fs.writeFileSync(pkgPath, pkg);

console.log('bundle-invoke: wrote', invokePath);