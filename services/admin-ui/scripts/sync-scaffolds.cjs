#!/usr/bin/env node
'use strict';

/**
 * Copy repo scaffolds/ (SoT) into public/scaffolds and build per-slot .zip for Admin download.
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

/** Minimal ZIP (store only) — no external zip(1) dependency. */
function zipStore(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  function u16(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n, 0);
    return b;
  }
  function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
  }

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0), // crc placeholder — fill below
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    const crc = crc32(data);
    local.writeUInt32LE(crc >>> 0, 14);

    const cen = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc >>> 0),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    parts.push(local);
    central.push(cen);
    offset += local.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBuf.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...parts, centralBuf, end]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

if (!fs.existsSync(srcRoot)) {
  if (fs.existsSync(path.join(destRoot, 'agent-nodejs.zip'))) {
    console.log('sync-scaffolds: SoT missing; keeping existing public/scaffolds');
    process.exit(0);
  }
  console.error('sync-scaffolds: missing SoT at', srcRoot);
  process.exit(1);
}

fs.rmSync(destRoot, { recursive: true, force: true });
fs.mkdirSync(destRoot, { recursive: true });

const allowlist = path.join(srcRoot, 'ALLOWED_PACKAGES.md');
if (fs.existsSync(allowlist)) {
  copyFile(allowlist, path.join(destRoot, 'ALLOWED_PACKAGES.md'));
}

for (const slot of SLOTS) {
  const dir = path.join(srcRoot, slot);
  if (!fs.existsSync(dir)) {
    console.error('sync-scaffolds: missing slot', slot);
    process.exit(1);
  }
  const entries = [];
  function walk(rel) {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs)) {
      if (name === '.venv' || name === '__pycache__' || name.startsWith('.')) continue;
      if (name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const src = path.join(dir, childRel);
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (!st.isFile()) continue;
      const destFile = path.join(destRoot, slot, childRel);
      copyFile(src, destFile);
      entries.push({
        name: childRel.replace(/\\/g, '/'),
        data: fs.readFileSync(src),
      });
    }
  }
  walk('');
  const dep =
    slot.endsWith('-nodejs')
      ? path.join(dir, 'package.json')
      : path.join(dir, 'requirements.txt');
  if (!fs.existsSync(dep)) {
    console.error('sync-scaffolds: missing deps file', dep);
    process.exit(1);
  }
  const zipPath = path.join(destRoot, `${slot}.zip`);
  fs.writeFileSync(zipPath, zipStore(entries));
}

const mainJs = path.join(destRoot, 'agent-nodejs', 'main.js');
const zipJs = path.join(destRoot, 'agent-nodejs.zip');
if (!fs.existsSync(mainJs) || !fs.existsSync(zipJs)) {
  console.error('sync-scaffolds: expected main.js and agent-nodejs.zip');
  process.exit(1);
}
console.log('sync-scaffolds: OK →', destRoot);
