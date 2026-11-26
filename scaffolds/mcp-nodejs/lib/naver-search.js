'use strict';

/** @type {ReadonlySet<string>} */
const SERVICES = new Set([
  'webkr',
  'news',
  'blog',
  'book',
  'encyc',
  'cafearticle',
  'kin',
  'image',
  'shop',
  'doc',
  'adult',
  'errata',
  'local',
]);

/**
 * @param {unknown} secrets
 * @returns {{ client_id: string, client_secret: string } | null}
 */
function materializeSecrets(secrets) {
  if (secrets && typeof secrets === 'object' && !Array.isArray(secrets)) {
    const id = secrets.client_id != null ? String(secrets.client_id) : '';
    const secret = secrets.client_secret != null ? String(secrets.client_secret) : '';
    if (id && secret) return { client_id: id, client_secret: secret };
  }
  const envId = process.env.NAVER_CLIENT_ID;
  const envSecret = process.env.NAVER_CLIENT_SECRET;
  if (envId && envSecret) return { client_id: envId, client_secret: envSecret };
  return null;
}

/**
 * @param {string} html
 */
function stripHighlight(html) {
  return String(html || '').replace(/<\/?b>/gi, '');
}

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.service]
 * @param {number} [opts.display]
 * @param {number} [opts.start]
 * @param {string} [opts.sort]
 * @param {{ client_id: string, client_secret: string }} opts.creds
 * @param {typeof fetch} [opts.fetchImpl]
 */
async function searchNaver(opts) {
  const query = opts.query != null ? String(opts.query).trim() : '';
  if (!query) {
    return { ok: false, error: 'query_required' };
  }
  let service = opts.service != null ? String(opts.service) : 'webkr';
  if (!SERVICES.has(service)) {
    return { ok: false, error: 'service_invalid', service };
  }
  const display = clampInt(opts.display, 1, 100, 10);
  const start = clampInt(opts.start, 1, 1000, 1);
  const sort = opts.sort != null ? String(opts.sort) : undefined;

  const url = new URL(`https://openapi.naver.com/v1/search/${service}.json`);
  url.searchParams.set('query', query);
  url.searchParams.set('display', String(display));
  url.searchParams.set('start', String(start));
  if (sort) url.searchParams.set('sort', sort);

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch_unavailable' };
  }

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      'X-Naver-Client-Id': opts.creds.client_id,
      'X-Naver-Client-Secret': opts.creds.client_secret,
    },
  });
  if (!res || res.ok === false) {
    const status = res && res.status != null ? res.status : 0;
    return { ok: false, error: 'upstream_error', status };
  }
  const body = typeof res.json === 'function' ? await res.json() : res;
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems.map((it) => ({
    title: stripHighlight(it && it.title),
    link: it && it.link != null ? String(it.link) : '',
    description: stripHighlight(it && it.description),
    pubDate: it && it.pubDate != null ? String(it.pubDate) : undefined,
  }));
  return {
    ok: true,
    service,
    total: body.total != null ? Number(body.total) : items.length,
    start: body.start != null ? Number(body.start) : start,
    display: body.display != null ? Number(body.display) : display,
    items,
  };
}

function clampInt(v, min, max, fallback) {
  const n = v == null || v === '' ? fallback : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

module.exports = {
  SERVICES,
  materializeSecrets,
  searchNaver,
  stripHighlight,
};
