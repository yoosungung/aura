# GHCR 제품 이미지 게시 (GHA)

**이 문서 범위:** `main` 푸시 시 제품 Deployment 이미지를 GHCR에 빌드·푸시 · 태그 `latest` + `sha-<short>` · `sha` 계열 **최근 3**개 유지.  
**Non-goals:** 매니페스트 `:local` → GHCR 컷오버 · multi-arch · Fission Function archive 게시 · live pull 스모크 필수.

게이트: `bash deploy/scripts/check-ghcr-images.sh`  
워크플로: [`.github/workflows/images.yml`](../../.github/workflows/images.yml)  
로컬 빌드(랩): `deploy/scripts/build-*-images.sh` → `aura/*:local`

---

## 태그

| 태그 | 용도 |
|------|------|
| `latest` | 랩/공유 클러스터 “항상 최신” 플로팅 |
| `sha-<short>` | 불변 핀 · 롤백·감사 (Git `GITHUB_SHA` 7자) |

배포 핀은 `sha-<short>`(또는 digest)를 쓴다. `latest`만으로 프로드 고정 금지.

---

## 이미지 ↔ 빌드

| GHCR 패키지 | context | Dockerfile | 로컬 대응 |
|-------------|---------|------------|-----------|
| `ghcr.io/<owner>/aura-gateway` | 저장소 루트 | `services/gateway/rs/Dockerfile` | `aura/gateway:local` |
| `ghcr.io/<owner>/aura-llm-gateway` | 저장소 루트 | `services/llm-gateway/rs/Dockerfile` | `aura/llm-gateway:local` |
| `ghcr.io/<owner>/aura-nats-rpc-bridge` | 저장소 루트 | `services/nats-rpc-bridge/rs/Dockerfile` | `aura/nats-rpc-bridge:local` |
| `ghcr.io/<owner>/aura-nats-task-bridge` | 저장소 루트 | `services/nats-task-bridge/rs/Dockerfile` | `aura/nats-task-bridge:local` |
| `ghcr.io/<owner>/aura-control-admin` | 저장소 루트 | `services/control/rs/Dockerfile` | `aura/control-admin:local` |
| `ghcr.io/<owner>/aura-admin-ui` | 저장소 루트 | `services/admin-ui/Dockerfile` | `aura/admin-ui:local` |

`<owner>` = `github.repository_owner`.

---

## Retention

GHCR 자동 보존 없음 → 워크플로 cleanup:

- 태그된 버전 **최근 3**개 유지 (`keep-n-tagged: 3`) — 최신 버전은 보통 `latest`+`sha-*` 공존
- untagged 삭제
- 랩 k8s는 당분간 **`aura/*:local`** + `IfNotPresent` 유지 (컷오버 후속)

---

## 운영 메모

1. 패키지 Settings → Actions에 저장소 `GITHUB_TOKEN` write 허용.
2. 첫 푸시 후 Packages에 `aura-*` 6개가 생긴다.
3. 클러스터가 GHCR을 쓸 때는 `imagePullSecrets` + 태그/`sha-*` 핀을 매니페스트에 반영(별 티켓).
