'use strict';

const assert = require('assert');
const { buildNatsTlsOptions, assertNatsMtlsConnect } = require('./nats-tls');

function main() {
  const opts = buildNatsTlsOptions({
    ca: 'ca-pem',
    cert: 'cert-pem',
    key: 'key-pem',
  });
  assert.deepStrictEqual(opts.tls, { ca: 'ca-pem', cert: 'cert-pem', key: 'key-pem' });

  assert.throws(() => buildNatsTlsOptions({ ca: 'x' }), /mtls_required/);

  assert.throws(
    () => assertNatsMtlsConnect('http://nats:4222', null),
    /nats_plaintext_transport_forbidden/
  );
  assert.throws(
    () => assertNatsMtlsConnect('tls://nats:4222', {}),
    /mtls_required/
  );

  assert.doesNotThrow(() =>
    assertNatsMtlsConnect('tls://nats:4222', {
      tls: { ca: 'c', cert: 'c', key: 'k' },
    })
  );

  console.log('nats-tls.selftest: PASS');
}

main();