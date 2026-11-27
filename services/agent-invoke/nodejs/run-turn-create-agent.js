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

const MAX_AGENT_DEPTH = 2;

function agentKey(name, version) {
  return `${name}@${version}`;
}

function withAgent(frame, agentName) {
  if (!agentName || !frame || typeof frame !== 'object') return frame;
  if (
    frame.type === 'token' ||
    frame.type === 'tool.started' ||
    frame.type === 'tool.finished'
  ) {
    return { ...frame, agent: agentName };
  }
  return frame;
}

function allowlistEntry(spec) {
  return (
    spec &&
    typeof spec.server === 'string' &&
    spec.server &&
    typeof spec.name === 'string' &&
    spec.name &&
    typeof spec.version === 'string' &&
    spec.version
  );
}

function bindMcpTool(mcpTool, principal, publish, runId, stream, spec) {
  const tool = spec.name;
  const server = spec.server;
  const version = spec.version;
  return {
    name: tool,
    description:
      spec.description || `MCP ${server}@${version} ${tool}`,
    invoke: async (input) => {
      const callTool = (input && (input.tool || input.name)) || tool;
      const callServer = (input && input.server) || server;
      const callVersion = (input && input.version) || version;
      const args =
        input && input.arguments && typeof input.arguments === 'object'
          ? input.arguments
          : input || {};
      if (stream && publish) {
        await publish(runId, { type: 'tool.started', tool: callTool, server: callServer });
      }
      const out =
        typeof mcpTool === 'function'
          ? await mcpTool({
              action: 'call',
              server: callServer,
              version: callVersion,
              tool: callTool,
              arguments: args,
              principal,
            })
          : { ok: false, error: 'mcp_tool_required' };
      if (stream && publish) {
        await publish(runId, {
          type: 'tool.finished',
          tool: callTool,
          server: callServer,
          summary: out && out.ok === false ? 'error' : 'ok',
        });
      }
      return out;
    },
  };
}

function wrapMcpTools(mcpTool, principal, publish, runId, stream, allowlist) {
  if (Array.isArray(allowlist)) {
    return allowlist
      .filter(allowlistEntry)
      .map((spec) => bindMcpTool(mcpTool, principal, publish, runId, stream, spec));
  }
  if (typeof mcpTool !== 'function') return [];
  return [
    bindMcpTool(mcpTool, principal, publish, runId, stream, {
      name: 'mcp_tool',
      server: 'default',
      version: '1.0.0',
      description: 'Call an MCP tool via aura.rpc.mcp.tool',
    }),
  ];
}

/**
 * Fallback when langchain createAgent is unavailable — still honors stream frames.
 */
async function stubAgentLoop(ctx, tools, publish) {
  const inputText =
    ctx.input && typeof ctx.input.text === 'string' ? ctx.input.text : '';
  const reply = ctx.memoryText
    ? `ack:${inputText || 'ok'}|mem:${String(ctx.memoryText).slice(0, 64)}`
    : `ack:${inputText || 'ok'}`;

  if (ctx.stream && publish) {
    const chunk = reply.length > 24 ? reply.slice(0, 24) : reply;
    await publish(ctx.run_id, { type: 'token', text: chunk });
    if (reply.length > 24) {
      await publish(ctx.run_id, {
        type: 'token',
        text: reply.slice(24),
      });
    }
  }

  let toolResult = null;
  const toolReq = ctx.input && ctx.input.tool;
  const matched = matchInputTool(tools, toolReq);
  if (matched) {
    toolResult = await matched.invoke({
      tool: toolReq.name || toolReq.tool,
      server: toolReq.server || 'default',
      version: toolReq.version || '1.0.0',
      arguments: toolReq.arguments || {},
    });
  }
  return { text: reply, toolResult, mode: 'stub_agent_loop' };
}

function matchInputTool(tools, toolReq) {
  if (!toolReq || !tools || !tools.length) return null;
  const name = toolReq.name || toolReq.tool;
  if (tools.length === 1 && tools[0].name === 'mcp_tool') return tools[0];
  return tools.find((t) => t.name === name) || null;
}

function subAgentTools(ctx, stack, depth, publish, opts) {
  const specs =
    ctx.cfg && Array.isArray(ctx.cfg.sub_agents) ? ctx.cfg.sub_agents : [];
  if (depth >= MAX_AGENT_DEPTH) return [];
  return specs
    .filter(
      (spec) =>
        spec &&
        typeof spec.name === 'string' &&
        spec.name &&
        typeof spec.version === 'string' &&
        spec.version,
    )
    .map((spec) => ({
      name: `subagent_${spec.name}`,
      description: spec.description || spec.name,
      invoke: async (input) => {
        const childKey = agentKey(spec.name, spec.version);
        if (stack.includes(childKey)) {
          const err = new Error('agent_cycle');
          err.status = 400;
          throw err;
        }
        if (depth + 1 > MAX_AGENT_DEPTH) {
          const err = new Error('agent_depth_exceeded');
          err.status = 400;
          throw err;
        }
        if (typeof ctx.resolve !== 'function') {
          const err = new Error('resolve_rpc_required');
          err.status = 500;
          throw err;
        }
        const resolved = await ctx.resolve({
          tenant_id: ctx.principal && ctx.principal.tenant_id,
          kind: 'agent',
          name: spec.name,
          version: spec.version,
          principal: ctx.principal,
        });
        if (!resolved || resolved.type === 'control.resolve.error') {
          const err = new Error('sub_agent_not_active');
          err.status = 404;
          throw err;
        }
        const text =
          (input && (input.text || input.task || input.query)) ||
          (typeof input === 'string' ? input : '');
        return createAgentRunTurn(
          {
            run_id: ctx.run_id,
            agent: spec.name,
            version: spec.version,
            session_id: ctx.session_id,
            input: { text: String(text) },
            principal: ctx.principal,
            cfg: (resolved && resolved.cfg) || {},
            secrets_ref: (resolved && resolved.secrets_ref) || null,
            packed: ctx.packed,
            memoryText: ctx.memoryText,
            stream: ctx.stream,
            publishStream: ctx.publishStream,
            mcpTool: ctx.mcpTool,
            resolve: ctx.resolve,
            depth: depth + 1,
            agentStack: stack,
            llmGatewayBaseUrl: ctx.llmGatewayBaseUrl,
            llmTransport: ctx.llmTransport,
            createAgent: ctx.createAgent,
            chatModel: ctx.chatModel,
          },
          opts,
        );
      },
    }));
}

/**
 * @param {object} ctx — same shape as handler defaultRunTurn
 * @param {object} [opts]
 */
async function createAgentRunTurn(ctx, opts) {
  const o = opts || {};
  const depth = ctx.depth || 1;
  if (depth > MAX_AGENT_DEPTH) {
    const err = new Error('agent_depth_exceeded');
    err.status = 400;
    throw err;
  }
  const stack = Array.isArray(ctx.agentStack) ? ctx.agentStack.slice() : [];
  if (ctx.agent && ctx.version && stack.includes(agentKey(ctx.agent, ctx.version))) {
    const err = new Error('agent_cycle');
    err.status = 400;
    throw err;
  }
  if (ctx.agent && ctx.version) stack.push(agentKey(ctx.agent, ctx.version));

  const stream = ctx.stream !== false;
  const rawPublish = ctx.publishStream;
  const agentName = ctx.agent || null;
  const publish = async (id, frame) => {
    if (!rawPublish) return undefined;
    return rawPublish(id, withAgent(frame, agentName));
  };
  const allowlist = ctx.cfg && Array.isArray(ctx.cfg.tools) ? ctx.cfg.tools : undefined;
  const tools = wrapMcpTools(
    ctx.mcpTool,
    ctx.principal,
    publish,
    ctx.run_id,
    stream,
    allowlist,
  ).concat(subAgentTools(ctx, stack, depth, publish, o));

  let chatModel = o.chatModel || ctx.chatModel;
  if (!chatModel && ctx.llmGatewayBaseUrl) {
    assertFunctionLlmEgress(ctx.llmGatewayBaseUrl);
    chatModel = createGatewayChatModel({
      baseUrl: ctx.llmGatewayBaseUrl,
      tenantId: ctx.principal && ctx.principal.tenant_id,
      model: (ctx.cfg && ctx.cfg.model) || 'aura-default',
      transport: ctx.llmTransport,
      routePin: ctx.routePin || (ctx.cfg && ctx.cfg.route_pin) || null,
    });
  }

  const createAgentInjected =
    o.createAgent !== undefined || (ctx && ctx.createAgent !== undefined);
  let createAgent =
    o.createAgent !== undefined ? o.createAgent : ctx.createAgent;
  if (createAgent === undefined) {
    createAgent = await tryLoadCreateAgent();
  }

  if (typeof createAgent !== 'function') {
    return stubAgentLoop(ctx, tools, publish);
  }
  // Auto-loaded langchain createAgent needs a BaseChatModel. Without chatModel
  // (no gateway), keep stub even when root workspaces install langchain.
  if (!createAgentInjected && !chatModel) {
    return stubAgentLoop(ctx, tools, publish);
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
    name: ctx.agent,
  });

  const userText =
    ctx.input && typeof ctx.input.text === 'string' ? ctx.input.text : '';

  let result;
  if (typeof agent.stream === 'function' && stream && publish) {
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
        await publish(ctx.run_id, { type: 'token', text: piece });
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
      (out && out.messages && evContent(out)) ||
      '';
    if (stream && publish && text) {
      await publish(ctx.run_id, { type: 'token', text: String(text) });
    }
    result = { text: String(text || ''), mode: 'create_agent_invoke' };
  }

  let toolResult = null;
  const toolReq = ctx.input && ctx.input.tool;
  const matched = matchInputTool(tools, toolReq);
  if (matched) {
    toolResult = await matched.invoke({
      tool: toolReq.name || toolReq.tool,
      server: toolReq.server || 'default',
      version: toolReq.version || '1.0.0',
      arguments: toolReq.arguments || {},
    });
  }
  result.toolResult = toolResult;
  return result;
}

function evContent(out) {
  const last = out && out.messages && out.messages.slice(-1)[0];
  return last && last.content;
}

module.exports = {
  createAgentRunTurn,
  tryLoadCreateAgent,
  wrapMcpTools,
  stubAgentLoop,
  assertFunctionLlmEgress,
};
