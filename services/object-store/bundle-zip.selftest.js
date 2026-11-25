'use strict';

const assert = require('assert');
const zlib = require('zlib');
const {
  isZip,
  unzipToMap,
  loadJsFactory,
} = require('./bundle-zip');

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

function zipStore(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, method } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const payload = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const m = method === 8 ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(m),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(raw.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      payload,
    ]);
    const cen = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(m),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(raw.length),
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

function main() {
  assert.strictEqual(isZip(Buffer.from('not zip')), false);

  const helper = "module.exports.flag = 'from-helper';\n";
  const mainJs =
    "const h = require('./lib/helper');\n" +
    'module.exports.factory = function factory(cfg) {\n' +
    '  return { async runTurn() { return { text: h.flag + ":" + (cfg && cfg.x) }; } };\n' +
    '};\n';
  const z = zipStore([
    { name: 'main.js', data: mainJs },
    { name: 'lib/helper.js', data: helper },
  ]);
  assert.ok(isZip(z));
  const map = unzipToMap(z);
  assert.ok(map.has('main.js'));
  assert.ok(map.has('lib/helper.js'));

  const factory = loadJsFactory(z, 'main:factory', require);
  assert.strictEqual(typeof factory, 'function');
  return Promise.resolve(factory({ x: 1 }, null)).then((inst) =>
    inst.runTurn().then((out) => {
      assert.strictEqual(out.text, 'from-helper:1');

      const plain =
        'module.exports.factory = function factory() { return { async runTurn() { return { ok: true }; } }; };';
      const pf = loadJsFactory(Buffer.from(plain), 'main:factory', require);
      return Promise.resolve(pf({}, null)).then((pinst) =>
        pinst.runTurn().then((o) => {
          assert.strictEqual(o.ok, true);

          const bad = zipStore([{ name: '../evil.js', data: 'x' }]);
          assert.throws(() => unzipToMap(bad), /bundle_zip_unsafe_path/);

          const nm = zipStore([{ name: 'node_modules/x.js', data: 'x' }]);
          assert.throws(() => unzipToMap(nm), /bundle_zip_node_modules_forbidden/);

          console.log('bundle-zip.selftest: PASS');
        })
      );
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
