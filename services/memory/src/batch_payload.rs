//! CronJob batch envelope builder (Node batch-payload.js parity).

use chrono::{Datelike, Duration, TimeZone, Utc};
use serde_json::{json, Value};

fn utc_month_start(d: chrono::DateTime<Utc>) -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(d.year(), d.month(), 1, 0, 0, 0)
        .single()
        .unwrap()
}

fn add_utc_months(d: chrono::DateTime<Utc>, n: i32) -> chrono::DateTime<Utc> {
    let mut y = d.year();
    let mut m = d.month() as i32 + n;
    while m > 12 {
        m -= 12;
        y += 1;
    }
    while m < 1 {
        m += 12;
        y -= 1;
    }
    Utc.with_ymd_and_hms(y, m as u32, 1, 0, 0, 0)
        .single()
        .unwrap()
}

fn month_label(d: chrono::DateTime<Utc>) -> String {
    format!("{}_{:02}", d.year(), d.month())
}

fn partition_name(kind: &str, month_start: chrono::DateTime<Utc>) -> String {
    let label = month_label(month_start);
    match kind {
        "audit" => format!("memory_audit_{label}"),
        "short_term" => format!("memory_items_short_term_{label}"),
        "episodic" => format!("memory_items_episodic_{label}"),
        _ => format!("memory_{kind}_{label}"),
    }
}

fn cold_month_partitions(
    kind: &str,
    hot_months: Option<i32>,
    hot_days: Option<i64>,
    lookback_months: i32,
    now: chrono::DateTime<Utc>,
) -> Vec<Value> {
    let cutoff = if let Some(days) = hot_days {
        now - Duration::days(days)
    } else {
        add_utc_months(utc_month_start(now), -(hot_months.unwrap_or(0)))
    };
    let mut out = Vec::new();
    let mut cursor = add_utc_months(utc_month_start(now), -lookback_months);
    let end = utc_month_start(now);
    while cursor < end {
        let upper = add_utc_months(cursor, 1);
        if upper <= cutoff {
            out.push(json!({
                "kind": kind,
                "name": partition_name(kind, cursor),
                "upper_bound": upper.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "archived": false
            }));
        }
        cursor = add_utc_months(cursor, 1);
    }
    out
}

pub fn build_batch_payload(subject: &str, tenant_id: &str, now: chrono::DateTime<Utc>) -> Result<Value, String> {
    let day = now.format("%Y-%m-%d").to_string();
    let occurred = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    match subject {
        "aura.tasks.memory.ttl" => {
            let mut partitions = cold_month_partitions("short_term", None, Some(14), 6, now);
            partitions.extend(cold_month_partitions("audit", Some(12), None, 24, now));
            partitions.extend(cold_month_partitions("episodic", Some(24), None, 36, now));
            Ok(json!({
                "id": format!("ttl:{day}"),
                "type": "memory.ttl",
                "tenant_id": tenant_id,
                "occurred_at": occurred,
                "payload": { "now": occurred, "partitions": partitions }
            }))
        }
        "aura.tasks.memory.archive" => {
            let partitions: Vec<Value> = cold_month_partitions("episodic", Some(24), None, 36, now)
                .into_iter()
                .map(|p| {
                    json!({
                        "name": p["name"],
                        "upper_bound": p["upper_bound"],
                        "row_count": 0,
                        "object_exists": false
                    })
                })
                .collect();
            Ok(json!({
                "id": format!("archive:{day}"),
                "type": "memory.archive",
                "tenant_id": tenant_id,
                "occurred_at": occurred,
                "payload": { "now": occurred, "partitions": partitions }
            }))
        }
        "aura.tasks.memory.object_gc" => Ok(json!({
            "id": format!("object-gc:{tenant_id}:{day}"),
            "type": "memory.object_gc",
            "tenant_id": tenant_id,
            "occurred_at": occurred,
            "payload": { "now": occurred, "limit": 100 }
        })),
        "aura.tasks.memory.consolidate" => Ok(json!({
            "id": format!("consolidate:{tenant_id}:{day}"),
            "type": "memory.consolidate",
            "tenant_id": tenant_id,
            "occurred_at": occurred,
            "payload": {
                "item_id": "00000000-0000-4000-8000-000000000001",
                "created_at": occurred,
                "from_type": "short_term",
                "to_type": "episodic",
                "reason": "session_boundary"
            }
        })),
        _ => Err(format!("unsupported_subject:{subject}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consolidate_payload_shape() {
        let now = Utc.with_ymd_and_hms(2026, 11, 28, 0, 0, 0).unwrap();
        let env = build_batch_payload(
            "aura.tasks.memory.consolidate",
            "00000000-0000-0000-0000-000000000000",
            now,
        )
        .unwrap();
        assert_eq!(env["type"], "memory.consolidate");
        assert_eq!(env["payload"]["reason"], "session_boundary");
    }
}
