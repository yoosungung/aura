'use strict';

/**
 * LLM provider catalog. ConfigMap JSON → ordered providers + optional embeddings.
 * Kinds: stub · ollama · openai · vllm · sglang.
 * Chat: POST {baseUrl}/chat/completions. Embeddings: POST {baseUrl}/embeddings.
 * API keys stay in the process env named by apiKeyEnv.
 */

const fs = require('fs');
const { createStubProvider } = require('./gateway');

const PROVIDER_KINDS = Object.freeze({
  stub: Object.freeze({ transport: 'stub' }),
  ollama: Object.freeze({
    transport: 'openai',
    defaultBaseUrl: 'http://ollama.aura.svc.cluster.local:11434/v1',
    defaultModel: 'gemma4:e2b',
  }),
  openai: Object.freeze({
    transport: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
  }),
  vllm: Object.freeze({
    transport: 'openai',
    defaultBaseUrl: 'http://vllm.aura.svc.cluster.local:8000/v1',
  }),
  sglang: Object.freeze({
    transport: 'openai',
    defaultBaseUrl: 'http://sglang.aura.svc.cluster.local:30000/v1',
  }),
});

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

/**
 * @param {object} spec
 * @param {{ fetch?: Function, env?: NodeJS.ProcessEnv }} opts
 */
function createOpenAiCompatProvider(spec, opts) {
  const meta = PROVIDER_KINDS[spec.kind];
  const baseUrl = String(spec.baseUrl || meta.defaultBaseUrl).replace(/\/$/, '');
  const pinned = spec.model || meta.defaultModel || null;
  const name = spec.name || spec.kind;
  const fetchImpl = opts && opts.fetch;
  const env = (opts && opts.env) || process.env;
  if (typeof fetchImpl !== 'function') {
    throw fail('provider_fetch_required');
  }
  return {
    name,
    kind: spec.kind,
    baseUrl,
    model: pinned,
    /**
     * @param {{ model?: string, messages?: object[] }} req
     */
    async complete(req) {
      const model = pinned || (req && req.model);
      if (!model) throw fail('provider_error');
      const headers = { 'content-type': 'application/json' };
      if (spec.apiKeyEnv) {
        const key = env[spec.apiKeyEnv];
        if (key) headers.authorization = `Bearer ${key}`;
      }
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: (req && req.messages) || [],
            stream: false,
          }),
        });
      } catch (e) {
        if (e && e.code === 'provider_error') throw e;
        throw fail('provider_error');
      }
      if (!res || !res.ok) {
        throw fail('provider_error');
      }
      const body = await res.json();
      return { ...body, provider: name, model };
    },
  };
}

/**
 * @param {string} text
 * @param {{ fetch?: Function, env?: NodeJS.ProcessEnv }} [opts]
 */
function providersFromConfig(text, opts) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw fail('provider_config_invalid');
  }
  const list = doc && Array.isArray(doc.providers) ? doc.providers : null;
  if (!list || list.length === 0) throw fail('provider_config_invalid');
  return list.map((row) => {
    if (!row || typeof row.kind !== 'string' || !PROVIDER_KINDS[row.kind]) {
      throw fail('provider_kind_invalid');
    }
    if (row.kind === 'stub') {
      return createStubProvider({ model: row.model });
    }
    return createOpenAiCompatProvider(row, opts || {});
  });
}

/**
 * Missing path or missing file → stub. Present file is parsed.
 * @param {string} [filePath]
 * @param {{ fetch?: Function, env?: NodeJS.ProcessEnv }} [opts]
 */
function loadProvidersFile(filePath, opts) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [createStubProvider()];
  }
  return providersFromConfig(fs.readFileSync(filePath, 'utf8'), opts);
}

/**
 * @param {object} spec
 * @param {{ fetch?: Function, env?: NodeJS.ProcessEnv }} [opts]
 */
function createEmbeddingsClient(spec, opts) {
  if (!spec || typeof spec !== 'object') throw fail('provider_config_invalid');
  if (typeof spec.kind !== 'string' || !PROVIDER_KINDS[spec.kind] || spec.kind === 'stub') {
    throw fail('provider_kind_invalid');
  }
  const meta = PROVIDER_KINDS[spec.kind];
  if (meta.transport !== 'openai') throw fail('provider_kind_invalid');
  const baseUrl = String(spec.baseUrl || meta.defaultBaseUrl).replace(/\/$/, '');
  const model = spec.model || meta.defaultModel;
  if (!model) throw fail('provider_config_invalid');
  const name = spec.name || `${spec.kind}-embed`;
  const fetchImpl = opts && opts.fetch;
  const env = (opts && opts.env) || process.env;
  if (typeof fetchImpl !== 'function') {
    throw fail('provider_fetch_required');
  }
  return {
    name,
    kind: spec.kind,
    baseUrl,
    model,
    /**
     * @param {{ input: string|string[], model?: string }} req
     */
    async embed(req) {
      const r = req && typeof req === 'object' ? req : {};
      if (r.input == null || r.input === '') throw fail('input_required');
      const headers = { 'content-type': 'application/json' };
      if (spec.apiKeyEnv) {
        const key = env[spec.apiKeyEnv];
        if (key) headers.authorization = `Bearer ${key}`;
      }
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: r.model || model,
            input: r.input,
          }),
        });
      } catch (e) {
        if (e && e.code) throw e;
        throw fail('provider_error');
      }
      if (!res || !res.ok) throw fail('provider_error');
      const body = await res.json();
      return { ...body, provider: name, model: r.model || model };
    },
  };
}

/**
 * @param {string} text
 * @param {{ fetch?: Function, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {ReturnType<typeof createEmbeddingsClient>|null}
 */
function embeddingsFromConfig(text, opts) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw fail('provider_config_invalid');
  }
  if (!doc || doc.embeddings == null) return null;
  return createEmbeddingsClient(doc.embeddings, opts || {});
}

/**
 * Missing file → null (embeddings route returns embeddings_not_configured).
 * @param {string} [filePath]
 * @param {{ fetch?: Function, env?: NodeJS.ProcessEnv }} [opts]
 */
function loadEmbeddingsConfig(filePath, opts) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return embeddingsFromConfig(fs.readFileSync(filePath, 'utf8'), opts);
}

module.exports = {
  PROVIDER_KINDS,
  providersFromConfig,
  loadProvidersFile,
  createEmbeddingsClient,
  embeddingsFromConfig,
  loadEmbeddingsConfig,
};
