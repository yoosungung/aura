'use strict';

/**
 * runTurn implementation using LangChain.js createAgent (M3.5).
 * Injectable createAgent / chatModel for TDD without live provider.
 */

const { createGatewayChatModel, assertFunctionLlmEgress } = require('./llm-gateway-model');

async function tryLoadCreateAgent() {
  try {
    const mod = await import('langchain');
    if (typeof mod.createAgent === 'function') return mod.createAgent;
  } catch (_) {
    /* optional peer */
  }
  try {
    // eslint-disable-next-line import/no-unresolved
    const mod = require('langchain');
    if (typeof mod.createAgent === 'function') return mod.createAgent;
  } catch (_) {
    /* optional peer */
  }
  return null;
}

function wrapMcpTools(mcpTool, principal, publishStream, runId, stream) {
  if (typeof mcpTool !== 'function') return [];
  // Dynamic tool: agent passes name via bound wrappers from list; single generic tool for stub.
  const runner = async (input) => {
    const tool = (input && input.tool) || (input && input.name) || 'tool';
    const server = (input && input.server) || 'default';
    const args =
      input && input.arguments && typeof input.arguments === 'object'
        ? input.arguments
        : input || {};
    if (stream && publishStream) {
      await publishStream(runId, { type: 'tool.started', tool, server });
    }
    const out = await mcpTool({
      action: 'call',
      server,
      version: (input && input.version) || '1.0.0',
      tool,
      arguments: args,
      principal,
    });
    if (stream && publishStream) {
      await publishStream(runId, {
        type: 'tool.finished',
        tool,
        server,
        summary: out && out.ok === false ? 'error' : 'ok',
      });
    }
    return out;
  };
  return [
    {
      name: 'mcp_tool',
      description: 'Call an MCP tool via aura.rpc.mcp.tool',
      invoke: runner,
    },
  ];
}

/**
 * Fallback when langchain createAgent is unavailable — still honors stream frames.
 */
async function stubAgentLoop(ctx, tools) {
  const inputText =
    ctx.input && typeof ctx.input.text === 'string' ? ctx.input.text : '';
  const reply = ctx.memoryText
    ? `ack:${inputText || 'ok'}|mem:${String(ctx.memoryText).slice(0, 64)}`
    : `ack:${inputText || 'ok'}`;

  if (ctx.stream && ctx.publishStream) {
    const chunk = reply.length > 24 ? reply.slice(0, 24) : reply;
    await ctx.publishStream(ctx.run_id, { type: 'token', text: chunk });
    if (reply.length > 24) {
      await ctx.publishStream(ctx.run_id, {
        type: 'token',
        text: reply.slice(24),
      });
    }
  }

  let toolResult = null;
  const toolReq = ctx.input && ctx.input.tool;
  if (toolReq && tools[0] && typeof tools[0].invoke === 'function') {
    toolResult = await tools[0].invoke({
      tool: toolReq.name || toolReq.tool,
      server: toolReq.server || 'default',
      version: toolReq.version || '1.0.0',
      arguments: toolReq.arguments || {},
    });
  }
  return { text: reply, toolResult, mode: 'stub_agent_loop' };
}

/**
 * @param {object} ctx — same shape as handler defaultRunTurn
 * @param {object} [opts]
 */
async function createAgentRunTurn(ctx, opts) {
  const o = opts || {};
  const stream = ctx.stream !== false;
  const publishStream = ctx.publishStream;
  const tools = wrapMcpTools(
    ctx.mcpTool,
    ctx.principal,
    publishStream,
    ctx.run_id,
    stream,
  );

  let chatModel = o.chatModel || ctx.chatModel;
  if (!chatModel && ctx.llmGatewayBaseUrl) {
    assertFunctionLlmEgress(ctx.llmGatewayBaseUrl);
    chatModel = createGatewayChatModel({
      baseUrl: ctx.llmGatewayBaseUrl,
      tenantId: ctx.principal && ctx.principal.tenant_id,
      model: (ctx.cfg && ctx.cfg.model) || 'aura-default',
      transport: ctx.llmTransport,
    });
  }

  let createAgent =
    o.createAgent !== undefined ? o.createAgent : ctx.createAgent;
  if (createAgent === undefined) {
    createAgent = await tryLoadCreateAgent();
  }

  if (typeof createAgent !== 'function') {
    return stubAgentLoop(ctx, tools);
  }

  const systemPrompt = [
    (ctx.cfg && ctx.cfg.system_prompt) || 'You are an Aura agent.',
    ctx.memoryText ? `\n\nMemory context:\n${ctx.memoryText}` : '',
  ].join('');

  const agent = createAgent({
    model: chatModel || {
      async invoke() {
        return { content: 'ack' };
      },
    },
    tools,
    systemPrompt,
  });

  const userText =
    ctx.input && typeof ctx.input.text === 'string' ? ctx.input.text : '';

  let result;
  if (typeof agent.stream === 'function' && stream && publishStream) {
    const iterable = await agent.stream({
      messages: [{ role: 'user', content: userText }],
    });
    let text = '';
    for await (const ev of iterable) {
      const piece =
        (ev && ev.content) ||
        (ev && ev.text) ||
        (ev && ev.messages && ev.messages.slice(-1)[0] && ev.messages.slice(-1)[0].content) ||
        '';
      if (typeof piece === 'string' && piece) {
        text += piece;
        await publishStream(ctx.run_id, { type: 'token', text: piece });
      }
    }
    result = { text, mode: 'create_agent_stream' };
  } else {
    const out = await agent.invoke({
      messages: [{ role: 'user', content: userText }],
    });
    const text =
      (out && out.content) ||
      (out && out.text) ||
      (out && out.messages && out.messages.slice(-1)[0] && out.messages.slice(-1)[0].content) ||
      '';
    if (stream && publishStream && text) {
      await publishStream(ctx.run_id, { type: 'token', text: String(text) });
    }
    result = { text: String(text || ''), mode: 'create_agent_invoke' };
  }

  // Optional explicit tool from input (contract parity with defaultRunTurn)
  let toolResult = null;
  const toolReq = ctx.input && ctx.input.tool;
  if (toolReq && tools[0]) {
    toolResult = await tools[0].invoke({
      tool: toolReq.name || toolReq.tool,
      server: toolReq.server || 'default',
      version: toolReq.version || '1.0.0',
      arguments: toolReq.arguments || {},
    });
  }
  result.toolResult = toolResult;
  return result;
}

module.exports = {
  createAgentRunTurn,
  tryLoadCreateAgent,
  wrapMcpTools,
  stubAgentLoop,
  assertFunctionLlmEgress,
};
