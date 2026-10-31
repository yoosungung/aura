---
name: ontology-extract
description: Use when extracting Customer ontology nodes and edges after a conversation is resolved.
---

# ontology-extract

resolved 대화에서 PainPoint·Preference·Product만 뽑는다. 추론 중 그래프를 쓰지 않는다.

## Instructions

1. Customer 노드 `external_ref_id`는 `contacts.id`다.
2. 관계: `PREFERS` / `EXPERIENCED` / `CAUSED_BY` / `RESOLVED_BY`.
3. 추측 노드는 만들지 않는다. 대화에 나온 이름만 쓴다.
