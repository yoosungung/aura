'use strict';

/**
 * Span attribute builders for Function · NATS · PG (M4 OTel wire).
 * No live exporter SDK — callers attach attrs to their tracer of choice.
 */

const { assertSafeAttributes } = require('./attributes');

function contextAttrs(input) {
  return {
    'aura.tenant_id': input.tenant_id,
    'aura.session_id': input.session_id,
    'aura.run_id': input.run_id,
  };
}

/**
 * Function / FaaS span attributes.
 * @param {object} input
 */
function buildFunctionSpanAttributes(input) {
  const attrs = {
    ...contextAttrs(input),
    'faas.name': input.function_name,
    'aura.function.name': input.function_name,
  };
  if (input.rpc_subject) {
    attrs['aura.rpc.subject'] = input.rpc_subject;
  }
  return assertSafeAttributes(attrs);
}

/**
 * NATS messaging span attributes (semconv messaging.*).
 * @param {object} input
 */
function buildNatsSpanAttributes(input) {
  const attrs = {
    ...contextAttrs(input),
    'messaging.system.name': 'nats',
    'messaging.operation.name': input.operation,
    'messaging.destination.name': input.subject,
  };
  return assertSafeAttributes(attrs);
}

/**
 * PostgreSQL client span attributes. Never includes query params or DSN.
 * @param {object} input
 */
function buildPgSpanAttributes(input) {
  const attrs = {
    ...contextAttrs(input),
    'db.system.name': 'postgresql',
    'db.operation.name': input.operation,
    'db.query.summary': input.summary,
  };
  if (input.query_text) {
    // Parameterized text only — callers must not interpolate secrets.
    attrs['db.query.text'] = input.query_text;
  }
  // Intentionally ignore query_params / connection_string even if passed.
  return assertSafeAttributes(attrs);
}

module.exports = {
  buildFunctionSpanAttributes,
  buildNatsSpanAttributes,
  buildPgSpanAttributes,
};
