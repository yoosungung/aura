/**
 * Tenant agent bundle scaffold (nodejs).
 * Same agent as agent-python: tools = naver_search + weather (via mcp_invoke, not inlined).
 * Upload folder as zip (without node_modules). Entrypoint: main:factory
 */
'use strict';

const { tag } = require('./lib/meta');
const {
  DEFAULT_SYSTEM_PROMPT,
  resolveTools,
  matchTool,
} = require('./lib/tools');

/**
 * @param {object} cfg
 * @param {string|null} secrets_ref
 */
function factory(cfg, secrets_ref) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const system =
    (c.system_prompt != null && String(c.system_prompt)) ||
    (c.systemPrompt != null && String(c.systemPrompt)) ||
    DEFAULT_SYSTEM_PROMPT;
  const tools = resolveTools(c.tools);
  const localMcp = typeof c._mcp_tool === 'function' ? c._mcp_tool : null;

  return {
    /**
     * Platform passes full ctx (`input`, `mcpTool`, …). Local tests may pass a flat input object.
     * @param {object} ctx
     */
    async runTurn(ctx) {
      const frame = ctx && typeof ctx === 'object' ? ctx : {};
      const input =
        frame.input && typeof frame.input === 'object' ? frame.input : frame;
      const message =
        (typeof input.text === 'string' && input.text) ||
        (typeof input.message === 'string' && input.message) ||
        '';
      const mcpTool =
        typeof frame.mcpTool === 'function' ? frame.mcpTool : localMcp;

      let toolResult = null;
      const toolReq = input.tool;
      if (toolReq) {
        const spec = matchTool(tools, toolReq);
        if (!spec) {
          return {
            ok: false,
            error: 'tool_not_allowed',
            tool: toolReq.name || toolReq.tool || null,
            tools,
          };
        }
        if (typeof mcpTool !== 'function') {
          return { ok: false, error: 'mcp_tool_required', tools };
        }
        toolResult = await mcpTool({
          action: 'call',
          server: toolReq.server || spec.server,
          version: toolReq.version || spec.version,
          tool: spec.name,
          arguments: toolReq.arguments || toolReq.input || {},
        });
      }

      return {
        ok: true,
        tag,
        text: message ? `ack:${message}` : 'ack',
        system,
        tools,
        toolResult,
        secrets_ref:
          frame.secrets_ref != null ? frame.secrets_ref : secrets_ref || null,
      };
    },
  };
}

module.exports = { factory };
