# 그래프 순회 방어 한도 (M1)

계약: [ARCHITECTURE.md](../../ARCHITECTURE.md) §1 #15 · **§6.2.4**.  
일정: [ROADMAP.md](../../ROADMAP.md) M1 (인덱스·수치 고정) · M4 (`svc-memory` recall graph walk **구현**).  
전제 DDL: [`../sql/memory_nodes_edges.sql`](../sql/memory_nodes_edges.sql) (`idx_memory_edges_out` / `idx_memory_edges_in`).

**이 문서 범위:** 핫 경로 partial 인덱스 형태와 순회 가드 수치를 **고정**.  
**Non-goals:** recall/graph walk Function 본구현 · embeddings/HNSW · TTL job · RRF 가중치 튜닝 · Soft-delete 이력 btree(선택).

수치 출처: ARCHITECTURE §6.2.4 (기획 확정 초안 → M1 잠금). 운영 튜닝은 M4 부하 후 결정 로그 1행 + 이 문서·§6.2.4를 **같이** 고친다 — 여기서 새 숫자를 발명하지 않는다.

---

## 핫 경로 인덱스 (M1 DDL)

| 인덱스 | 컬럼 | Predicate |
|--------|------|-----------|
| `idx_memory_edges_out` | `(tenant_id, source_node_id, relation_type)` | `WHERE valid_until IS NULL` |
| `idx_memory_edges_in` | `(tenant_id, target_node_id, relation_type)` | `WHERE valid_until IS NULL` |

`valid_until IS NULL` = 현재 유효(또는 만료 없음). 만료 임박 행은 배치가 `valid_until`을 설정해 핫 집합에서 제외한다. 감사·이력용 만료 포함 btree는 선택·핫 경로 금지.

---

## 유효 엣지 predicate (모든 순회 SQL)

```sql
valid_from <= now()
AND (valid_until IS NULL OR valid_until > now())
```

핫 인덱스는 `valid_until IS NULL` partial과 맞춘다. SQL predicate의 `valid_until > now()` 분기는 인덱스 밖(드묾)일 수 있다 — M4에서 배치가 만료를 NULL→타임스탬프로 옮기면 핫 집합과 일치한다.

---

## 고정 수치 (M1 · 구현=M4)

| 가드 | 값 | 의미 |
|------|----|------|
| `max_depth` | **2** | 재귀/반복 상한. 3+ 금지 |
| `per_hop_limit` | **50** | 노드당 확장 엣지 상한(방향·relation 합산) |
| `max_nodes_total` | **100** | 한 recall 그래프 확장 노드 상한 |
| `max_edges_total` | **200** | 한 recall에서 읽는 엣지 상한 |
| `supernode_degree_cap` | **64** | 허브 노드 fan-out 캡 |
| `cycle` | **visited** set | 방문한 `node_id` 재확장 금지 |

---

## 알고리즘 골격 (M4 구현)

1. 시드: vector/BM25/아이템 → `memory_nodes` (소수).
2. depth 1..`max_depth`: frontier마다 **out+in**을 유효 predicate로 조회, 노드당 `per_hop_limit`, 슈퍼노드는 `supernode_degree_cap`.
3. `visited`에 없으면 추가; `max_nodes_total` / `max_edges_total`이면 중단.
4. 결과를 recall RRF 후보에 합류(가중치는 `svc-memory` DESIGN).

**금지:** `WITH RECURSIVE` 무제한; `target_node_id` 풀스캔; 테넌트 가드 없는 조인; depth>2.

---

## V1.x 매핑

ROADMAP M1: *edges out/in partial + 순회 한도 DESIGN* → 이 문서 + DDL 인덱스.  
구현·스모크(실 walk)는 M4 hybrid recall graph 단계.

---

## 관련 링크

- §6.2.4 · §1 #15
- ROADMAP 결정 로그 (2026-11-17 그래프 순회 방어 · 2026-11-18 수치 M1 고정)
- 정적 게이트: `bash deploy/scripts/check-memory-graph-traversal.sh`
