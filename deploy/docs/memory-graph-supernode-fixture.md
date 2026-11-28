# 슈퍼노드 픽스처 (M4)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #15 · **§6.2.4**.  
순회 한도·walk: [`memory-graph-traversal.md`](memory-graph-traversal.md) · [`../../services/memory/src/lib.rs`](../../services/memory/src/lib.rs) (`GRAPH_*` / `SUPERNODE_*`).

**이 문서 범위:** 허브 1노드에 엣지 **≫** `supernode_degree_cap` / `per_hop_limit` 인 픽스처로  
(1) 방어 walk가 **반환·읽기 상한**을 지키고,  
(2) 쿼리 `LIMIT`이 cap 이하이며,  
(3) **쿼리 시간**(wall clock)이 예산 안이고,  
(4) 폭증(허브 degree만큼 전부 적재)이 없음을 회귀한다.  
**Non-goals:** live PG apply 필수 · RRF 가중치 튜닝 · TTL/archive · 스키마 변경 · unbounded recursive CTE.

수치 출처: §6.2.4 / `GRAPH_LIMITS` (발명 금지). 튜닝 시 결정 로그 + [`memory-graph-traversal.md`](memory-graph-traversal.md)·§6.2.4를 같이 고친다.

---

## 픽스처 형태

| 항목 | 값 |
|------|-----|
| 허브 | 시드 노드 1개 (`hub` ← `hub-item`) |
| `HUB_DEGREE` | **500** (≫ `supernode_degree_cap` **64**, ≫ `per_hop_limit` **50**) |
| 방향 | out 위주(spoke `item_id` 부여); in은 0 |
| 클라이언트 | in-memory — production SQL과 같이 **`LIMIT` honor** |
| walk limits | M1 고정 `GRAPH_LIMITS` (`max_depth=2` 등) |
| 실효 확장 | `expandLimitForNode` = `min(50, 64)` = **50** |
| wall budget | selftest **&lt; 2000** ms |
| ON (합격) | `walkGraph` 후 candidates≤50 · `truncated=true` · edge `LIMIT`≤50 · rows_returned &lt; hub_degree · nodes/edges ≤ 전역 상한 |
| OFF 대조 | `probeUncappedHubDegree` = **500** — 캡 없을 때 폭증 재현 |

**금지:** 허브 degree를 전부 메모리에 올린 뒤 앱에서 slice만 하는 walk · `LIMIT` 없는 edge SELECT · depth>2.

---

## 합격 / 실패

| 결과 | 의미 | 다음 |
|------|------|------|
| ON: candidates≤50 ∧ truncated ∧ LIMIT≤50 ∧ OFF=500 ∧ wall&lt;2s | cap이 쿼리·반환·시간 모두에서 동작 | M4 체크 완료 |
| ON candidates &gt; expandCap | cap 미적용 / slice-after-fetch | **FAIL** — walk 수정 |
| OFF &lt; hub_degree | 픽스처 degree 부족 | hub_degree를 ≫ cap으로 키움 |
| wall ≥ 2s | 폭증·hang 의심 | **FAIL** |

---

## 게이트

```bash
bash deploy/scripts/check-memory-graph-supernode.sh
cargo test -p aura-memory --lib supernode
```

---

## V1.x 매핑

ROADMAP M4: *슈퍼노드 픽스처: 허브 1노드에 엣지 ≫ cap → 쿼리 시간/반환 상한 준수(폭발 없음)*  
→ 이 문서 + `SUPERNODE_* caps in aura-memory` + `check-memory-graph-supernode.sh`.

---

## 관련 링크

- §6.2.4 · §1 #15 · [`memory-graph-traversal.md`](memory-graph-traversal.md)
- ROADMAP 결정 로그 (2026-11-17 그래프 순회 방어 · 2026-11-19 M4 walk · 본 픽스처)
