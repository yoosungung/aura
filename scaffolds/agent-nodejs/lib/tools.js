'use strict';

/** Default cfg.tools — same contract as agent-python. MCP code is NOT in this zip. */
const DEFAULT_TOOLS = Object.freeze([
  Object.freeze({
    server: 'naver-search',
    version: '1',
    name: 'naver_search',
    description: 'Naver Search MCP (secrets_ref / Client Id·Secret)',
  }),
  Object.freeze({
    server: 'weather',
    version: '1',
    name: 'weather',
    description: 'Open-Meteo weather MCP (no API key)',
  }),
]);

const DEFAULT_SYSTEM_PROMPT =
  'You are a scaffold research agent. Use naver_search for Korean web/news search and weather for Open-Meteo forecasts. Do not invent tool results.';

/**
 * @param {unknown} cfgTools
 * @returns {{ server: string, version: string, name: string, description?: string }[]}
 */
function resolveTools(cfgTools) {
  if (!Array.isArray(cfgTools)) return DEFAULT_TOOLS.map((t) => ({ ...t }));
  return cfgTools
    .filter(
      (t) =>
        t &&
        typeof t.server === 'string' &&
        t.server &&
        typeof t.name === 'string' &&
        t.name &&
        typeof t.version === 'string' &&
        t.version,
    )
    .map((t) => ({
      server: t.server,
      version: t.version,
      name: t.name,
      description: t.description != null ? String(t.description) : undefined,
    }));
}

/**
 * @param {object[]} allowlist
 * @param {object|null|undefined} toolReq
 */
function matchTool(allowlist, toolReq) {
  if (!toolReq || typeof toolReq !== 'object') return null;
  const name = toolReq.name || toolReq.tool;
  if (typeof name !== 'string' || !name) return null;
  return allowlist.find((t) => t.name === name) || null;
}

module.exports = {
  DEFAULT_TOOLS,
  DEFAULT_SYSTEM_PROMPT,
  resolveTools,
  matchTool,
};
