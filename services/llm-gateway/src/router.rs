//! Content router — aura-auto heuristic (parity with router.js).

use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

pub const AUTO_MODEL: &str = "aura-auto";

fn code_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)```|`[^`]+`|\b(function|class|def|import|const|let|var|SELECT|FROM)\b")
            .unwrap()
    })
}
fn math_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(prove|theorem|integral|derivative|equation|sqrt)\b|[∑∫√]|\$\$|\\\(|\\\[").unwrap()
    })
}
fn complex_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(step[- ]by[- ]step|analyze|design|architect|refactor|debug|reason|multi[- ]?hop|plan)\b")
            .unwrap()
    })
}
fn simple_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|ping)\b").unwrap()
    })
}

fn tier_rank(t: &str) -> Option<i32> {
    match t {
        "simple" => Some(0),
        "medium" => Some(1),
        "complex" => Some(2),
        _ => None,
    }
}

pub fn normalize_tier(pin: Option<&str>) -> Option<String> {
    let t = pin?.trim().to_ascii_lowercase();
    if t.is_empty() {
        return None;
    }
    if tier_rank(&t).is_some() {
        Some(t)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Score {
    pub tier: String,
    pub reason: String,
    pub score: i32,
}

pub fn score_prompt(messages: &[Value]) -> Score {
    let mut last_user = String::new();
    let mut toolish = 0;
    let mut turns = 0;
    for m in messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if matches!(role, "user" | "assistant" | "tool" | "function") {
            turns += 1;
        }
        if role == "tool" || role == "function" || m.get("tool_calls").is_some() {
            toolish += 1;
        }
        if role == "user" {
            last_user = match m.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
        }
    }

    let mut score = 0;
    let mut reasons = Vec::new();
    let len = last_user.len();
    if len > 1200 {
        score += 3;
        reasons.push("long_prompt");
    } else if len > 400 {
        score += 1;
        reasons.push("mid_prompt");
    }
    if code_re().is_match(&last_user) {
        score += 2;
        reasons.push("code");
    }
    if math_re().is_match(&last_user) {
        score += 2;
        reasons.push("math");
    }
    if complex_re().is_match(&last_user) {
        score += 2;
        reasons.push("complex_cue");
    }
    if turns >= 6 {
        score += 2;
        reasons.push("many_turns");
    } else if turns >= 3 {
        score += 1;
        reasons.push("multi_turn");
    }
    if toolish > 0 {
        score += 2;
        reasons.push("tool_context");
    }
    if score == 0 && simple_re().is_match(last_user.trim()) {
        reasons.push("simple_greeting");
    }

    let tier = if score <= 1 {
        "simple"
    } else if score >= 4 {
        "complex"
    } else {
        "medium"
    };
    Score {
        tier: tier.into(),
        reason: if reasons.is_empty() {
            "default_medium".into()
        } else {
            reasons.join("+")
        },
        score,
    }
}

fn apply_pin(classified: &str, pin: Option<&str>) -> (String, Option<String>) {
    let Some(p) = normalize_tier(pin) else {
        return (classified.into(), None);
    };
    if tier_rank(&p).unwrap() > tier_rank(classified).unwrap_or(0) {
        (p.clone(), Some(p))
    } else {
        (classified.into(), Some(p))
    }
}

fn model_for_tier(tiers: &HashMap<String, String>, tier: &str) -> Option<String> {
    if let Some(m) = tiers.get(tier) {
        return Some(m.clone());
    }
    let order = ["simple", "medium", "complex"];
    let idx = tier_rank(tier).unwrap_or(1) as usize;
    for t in order.iter().skip(idx + 1) {
        if let Some(m) = tiers.get(*t) {
            return Some(m.clone());
        }
    }
    for t in order.iter().take(idx).rev() {
        if let Some(m) = tiers.get(*t) {
            return Some(m.clone());
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct RouteResult {
    pub routed: bool,
    pub model: String,
    pub route: Option<RouteInfo>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RouteInfo {
    pub tier: String,
    pub reason: String,
    pub model_selected: String,
    pub pin: Option<String>,
}

pub fn resolve_route(
    model: &str,
    messages: &[Value],
    pin: Option<&str>,
    tiers: Option<&HashMap<String, String>>,
) -> RouteResult {
    if model != AUTO_MODEL {
        return RouteResult {
            routed: false,
            model: model.to_string(),
            route: None,
            error: None,
        };
    }
    let scored = score_prompt(messages);
    let (tier, pin_out) = apply_pin(&scored.tier, pin);
    let empty = HashMap::new();
    let map = tiers.unwrap_or(&empty);
    match model_for_tier(map, &tier) {
        Some(selected) => RouteResult {
            routed: true,
            model: selected.clone(),
            route: Some(RouteInfo {
                tier,
                reason: scored.reason,
                model_selected: selected,
                pin: pin_out,
            }),
            error: None,
        },
        None => RouteResult {
            routed: true,
            model: model.to_string(),
            route: Some(RouteInfo {
                tier,
                reason: scored.reason,
                model_selected: String::new(),
                pin: pin_out,
            }),
            error: Some("routing_tiers_empty".into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn greeting_is_simple() {
        let msgs = vec![json!({"role":"user","content":"hello"})];
        let s = score_prompt(&msgs);
        assert_eq!(s.tier, "simple");
    }

    #[test]
    fn aura_auto_selects_tier_model() {
        let mut tiers = HashMap::new();
        tiers.insert("simple".into(), "m-simple".into());
        tiers.insert("medium".into(), "m-med".into());
        tiers.insert("complex".into(), "m-cplx".into());
        let msgs = vec![json!({"role":"user","content":"hi"})];
        let r = resolve_route(AUTO_MODEL, &msgs, None, Some(&tiers));
        assert!(r.routed);
        assert_eq!(r.model, "m-simple");
        assert!(r.error.is_none());
    }

    #[test]
    fn pin_never_downgrades() {
        let mut tiers = HashMap::new();
        tiers.insert("simple".into(), "s".into());
        tiers.insert("complex".into(), "c".into());
        let msgs = vec![json!({"role":"user","content":"hi"})];
        let r = resolve_route(AUTO_MODEL, &msgs, Some("complex"), Some(&tiers));
        assert_eq!(r.route.as_ref().unwrap().tier, "complex");
        assert_eq!(r.model, "c");
    }
}
