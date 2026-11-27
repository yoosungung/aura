'use strict';

/**
 * Content router — heuristic simple|medium|complex for model "aura-auto" (§9.4 M5.1).
 * Availability Fallback stays in gateway.js after resolve.
 */

const AUTO_MODEL = 'aura-auto';
const TIERS = Object.freeze(['simple', 'medium', 'complex']);
const TIER_RANK = Object.freeze({ simple: 0, medium: 1, complex: 2 });

const CODE_RE = /```|`[^`]+`|\b(function|class|def|import|const|let|var|SELECT|FROM)\b/i;
const MATH_RE = /\b(prove|theorem|integral|derivative|equation|sqrt|∑|∫)\b|[∑∫√]|\$\$|\\\(|\\\[/i;
const COMPLEX_RE =
  /\b(step[- ]by[- ]step|analyze|design|architect|refactor|debug|reason|multi[- ]?hop|plan)\b/i;
const SIMPLE_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|ping)\b/i;

/**
 * @param {unknown} pin
 * @returns {'simple'|'medium'|'complex'|null}
 */
function normalizeTier(pin) {
  if (pin == null || pin === '') return null;
  const t = String(pin).toLowerCase().trim();
  return TIER_RANK[t] != null ? t : null;
}

/**
 * @param {object[]} messages
 * @returns {{ tier: 'simple'|'medium'|'complex', reason: string, score: number }}
 */
function scorePrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let lastUser = '';
  let toolish = 0;
  let turns = 0;
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '');
    if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'function') {
      turns += 1;
    }
    if (role === 'tool' || role === 'function' || m.tool_calls) toolish += 1;
    if (role === 'user') {
      lastUser = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    }
  }

  let score = 0;
  const reasons = [];
  const len = Buffer.byteLength(lastUser || '', 'utf8');
  if (len > 1200) {
    score += 3;
    reasons.push('long_prompt');
  } else if (len > 400) {
    score += 1;
    reasons.push('mid_prompt');
  }

  if (CODE_RE.test(lastUser)) {
    score += 2;
    reasons.push('code');
  }
  if (MATH_RE.test(lastUser)) {
    score += 2;
    reasons.push('math');
  }
  if (COMPLEX_RE.test(lastUser)) {
    score += 2;
    reasons.push('complex_cue');
  }
  if (turns >= 6) {
    score += 2;
    reasons.push('many_turns');
  } else if (turns >= 3) {
    score += 1;
    reasons.push('multi_turn');
  }
  if (toolish > 0) {
    score += 2;
    reasons.push('tool_context');
  }

  if (score === 0 && SIMPLE_RE.test((lastUser || '').trim())) {
    reasons.push('simple_greeting');
  }

  let tier = 'medium';
  if (score <= 1) tier = 'simple';
  else if (score >= 4) tier = 'complex';

  return {
    tier,
    reason: reasons.length ? reasons.join('+') : 'default_medium',
    score,
  };
}

/**
 * Pick highest of classified vs pin (never downgrade).
 * @param {'simple'|'medium'|'complex'} classified
 * @param {'simple'|'medium'|'complex'|null} pin
 */
function applyPin(classified, pin) {
  const p = normalizeTier(pin);
  if (!p) return { tier: classified, pin: null };
  if (TIER_RANK[p] > TIER_RANK[classified]) {
    return { tier: p, pin: p };
  }
  return { tier: classified, pin: p };
}

/**
 * Resolve model id for a tier; empty → escalate up then down.
 * @param {Record<string, string>|undefined} tiers
 * @param {'simple'|'medium'|'complex'} tier
 */
function modelForTier(tiers, tier) {
  const map = tiers && typeof tiers === 'object' ? tiers : {};
  if (map[tier]) return String(map[tier]);
  const idx = TIER_RANK[tier];
  for (let i = idx + 1; i < TIERS.length; i += 1) {
    if (map[TIERS[i]]) return String(map[TIERS[i]]);
  }
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (map[TIERS[i]]) return String(map[TIERS[i]]);
  }
  return null;
}

/**
 * @param {{
 *   model?: string,
 *   messages?: object[],
 *   pin?: string|null,
 *   routingConfig?: { tiers?: Record<string, string> }|null,
 * }} opts
 * @returns {{
 *   routed: boolean,
 *   model: string,
 *   route?: { tier: string, reason: string, model_selected: string, pin: string|null },
 *   error?: string,
 * }}
 */
function resolveRoute(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const requested = o.model != null ? String(o.model) : '';
  if (requested !== AUTO_MODEL) {
    return { routed: false, model: requested };
  }

  const scored = scorePrompt(o.messages);
  const pinned = applyPin(scored.tier, o.pin);
  const tiers = o.routingConfig && o.routingConfig.tiers;
  const selected = modelForTier(tiers, pinned.tier);
  if (!selected) {
    return {
      routed: true,
      model: requested,
      error: 'routing_tiers_empty',
      route: {
        tier: pinned.tier,
        reason: scored.reason,
        model_selected: '',
        pin: pinned.pin,
      },
    };
  }

  return {
    routed: true,
    model: selected,
    route: {
      tier: pinned.tier,
      reason: scored.reason,
      model_selected: selected,
      pin: pinned.pin,
    },
  };
}

module.exports = {
  AUTO_MODEL,
  TIERS,
  TIER_RANK,
  scorePrompt,
  resolveRoute,
  normalizeTier,
  modelForTier,
  applyPin,
};
