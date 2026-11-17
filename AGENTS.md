# AGENTS.md

This file provides guidance to AI coding assistants (Claude Code, Codex, Gemini, ...) when working with code in this repository. `CLAUDE.md`와 `GEMINI.md`는 이 파일로의 심볼릭 링크다 — 정본은 `AGENTS.md` 하나.

에이전트·기여자가 **무엇을 어디서 읽고 어떻게 실행하는지**만 담는다. 불변 규칙은 [ARCHITECTURE.md](ARCHITECTURE.md), 일정은 [ROADMAP.md](ROADMAP.md).

## 1. Documentation layout (문서 용도)

각 문서는 하나의 명확한 용도만 가진다. 같은 내용을 여러 문서에 중복하지 않는다. 한쪽을 고칠 때 다른 쪽이 같이 바뀌어야 한다면 잘못 나눈 것이므로 합치거나 한쪽이 다른 쪽을 참조하게 만든다.

| 파일 | 용도 | 위치 |
|------|------|------|
| `AGENTS.md` (이 파일, 정본) ← `CLAUDE.md`, `GEMINI.md` 심볼릭 | 수행 방법 + 문서 레이아웃 + 현황 | 루트 |
| `ARCHITECTURE.md` | **계약사항(불변 규칙)** + 컴포넌트 *간* 인터페이스 형태(스키마·레이아웃·이벤트) | 루트 |
| `README.md` | 저장소 방문자용 소개 + 로컬 quickstart | 루트 |
| `ROADMAP.md` | 수행 계획(마일스톤·순서·미결정 항목) | 루트 |
| `<comp>/DESIGN.md` | 컴포넌트 *내부* 설계 + `## Commands` | 코드 진입 시: `services/memory/`, `services/control/`, `runtimes/` 등 |
| `deploy/SETUP.md` | 클러스터 부트스트랩 런북 (NATS·KEDA·Fission) | `deploy/` |
| `deploy/k8s/base/` | NATS JetStream Kustomize | `deploy/k8s/base/` |
| `deploy/k8s/async-smoke/` | async MQT echo (`aura.tasks.smoke` → resp/error, `minReplicaCount=0`) | `deploy/k8s/async-smoke/` |
| `deploy/k8s/sync-smoke/` | sync Warm (`newdeploy` MinScale≥2) + Core RR Deployment `aura-rpc-smoke-rr` (MQT 없음) | `deploy/k8s/sync-smoke/` |
| `deploy/scripts/` | `install-runtime.sh` · `ensure-streams.sh` · `apply-split-deploy.sh` · `check-split-deploy.sh` · `smoke-async-mqt.sh` · `smoke-sync-rpc.sh` · `smoke-*.sh` | `deploy/scripts/` |

규칙:

- **ARCHITECTURE.md §1 (계약) vs §2 이후 (형태).** §1은 "지켜야 하는 규칙(왜)" — 짧고 단정적. §2 이후는 "그 규칙을 구현하는 모양(어떻게)" — 스키마·필드·이벤트 목록. 규칙이 바뀌면 §1을 먼저 고치고 §2 이후를 따라 고친다.
- **ARCHITECTURE.md vs `<comp>/DESIGN.md`.** ARCHITECTURE는 컴포넌트 *간*, 서브폴더 DESIGN은 해당 컴포넌트 *내부*. 두 쪽에 같은 내용을 적지 않는다.
- **README.md vs ARCHITECTURE.md / DESIGN.md.** README는 **인간 독자**용이다. 계약·내부 설계는 README에 복사하지 않고 링크로만 둔다.
- **배포 가능한 패키지·실행 하네스**에는 README를 둘 수 있다 — 해당 디렉터리 **로컬 사용법만**.
- 파일이 새로 생기거나 용도가 바뀌면 위 표를 즉시 갱신한다.
- 배포 런북은 `deploy/SETUP.md`, Kustomize는 `deploy/k8s/base/`, CI는 `.github/workflows/ci.yml`. **빈 stub을 만들지 않는다** — 실제 절차·매니페스트가 생길 때 작성한다.

## 2. 수행 방법 (How we work in this repo)

- 계획·설계·구현 변경은 해당 문서를 먼저(또는 함께) 고친다: 계획 → `ROADMAP.md`, 설계·규칙 → `ARCHITECTURE.md` 또는 `<comp>/DESIGN.md`, 워크플로 → 이 파일.
- 코드가 처음 들어오는 컴포넌트는 그 폴더의 `DESIGN.md`를 함께 만들고, 필요 시 이 파일 §1 표·`ARCHITECTURE.md` §1을 갱신한다.
- 컴포넌트에 첫 코드가 들어오면 `DESIGN.md`에 **`## Commands`** 를 추가한다. 그 전까지 존재하지 않는 명령을 만들지 않는다.
- 개발은 TDD다. (스켈레톤 → 테스트 → 구현)
- 한국어/영어 혼용 허용. 한 문서 내 일관성(한국어 본문 + 영어 식별자).

### 참고 저장소 (계승 금지)

아이디어만 참고한다. 스키마·코드를 복사·이식하지 않는다.

- 로컬 `aura_old` (구 헬프데스크 Aura)
- [yoosungung/agent-runtime](https://github.com/yoosungung/agent-runtime)

## 3. Status

**기획 문서 고정 완료** — [ARCHITECTURE.md](ARCHITECTURE.md)·[ROADMAP.md](ROADMAP.md)·[README.md](README.md).

M0: NATS·KEDA·Fission 설치 + 스트림 + async/sync 분리(V0.1) + async echo/poison + V0.2 sync Core RR + **V0.4 `AURA_DLQ` ① Term** 완료.  
다음: (권장) PG 스모크 계획 ([ROADMAP.md](ROADMAP.md) M0) · Fission MQT Term 미들웨어 이식.

요약 계약: NATS 삼원화+DLQ; Fair Queue; LLM Gateway; 샌드박스/mTLS; PG Pooler+HA; GDPR erase; Warm sync SLA; `svc-memory`; 수명 파티션; iterative_scan; edges 가드. NATS Account는 출시 후.
