#!/usr/bin/env node
'use strict';

/**
 * Copy repo scaffolds/ (SoT) into public/scaffolds for Admin UI static download.
 * Usage: node scripts/sync-scaffolds.cjs [--from <dir>]
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fromArg = process.argv.indexOf('--from');
const srcRoot =
  fromArg >= 0 && process.argv[fromArg + 1]
    ? path.resolve(process.argv[fromArg + 1])
    : process.env.AURA_SCAFFOLDS_SOT
      ? path.resolve(process.env.AURA_SCAFFOLDS_SOT)
      : path.resolve(root, '../../scaffolds');
const destRoot = path.join(root, 'public', 'scaffolds');

const SLOTS = [
  'agent-nodejs',
  'agent-python',
  'mcp-nodejs',
  'mcp-python',
];

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

if (!fs.existsSync(srcRoot)) {
  // Docker: first RUN sync --from /tmp/…; npm prebuild may not see repo scaffolds/.
  if (fs.existsSync(path.join(destRoot, 'agent-nodejs', 'main.js'))) {
    console.log('sync-scaffolds: SoT missing; keeping existing public/scaffolds');
    process.exit(0);
  }
  console.error('sync-scaffolds: missing SoT at', srcRoot);
  process.exit(1);
}

fs.rmSync(destRoot, { recursive: true, force: true });
fs.mkdirSync(destRoot, { recursive: true });

for (const slot of SLOTS) {
  const dir = path.join(srcRoot, slot);
  if (!fs.existsSync(dir)) {
    console.error('sync-scaffolds: missing slot', slot);
    process.exit(1);
  }
  for (const name of fs.readdirSync(dir)) {
    if (name === '.venv' || name === '__pycache__' || name.startsWith('.')) continue;
    const src = path.join(dir, name);
    if (!fs.statSync(src).isFile()) continue;
    copyFile(src, path.join(destRoot, slot, name));
  }
}

const mainJs = path.join(destRoot, 'agent-nodejs', 'main.js');
if (!fs.existsSync(mainJs)) {
  console.error('sync-scaffolds: expected', mainJs);
  process.exit(1);
}
console.log('sync-scaffolds: OK →', destRoot);
