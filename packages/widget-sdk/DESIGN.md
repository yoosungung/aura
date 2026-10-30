# widget-sdk

외부 사이트에 붙는 라이브챗 위젯. 컴포넌트 간 계약은 [ARCHITECTURE.md](../../ARCHITECTURE.md) §7.

## 내부 설계

- 호스트는 로더만 실행한다. 본체는 `{helpdeskOrigin}/widget.html` iframe이다.
- `baseUrl`은 `http`/`https`만 받고 origin만 쓴다. `javascript:`·`data:`는 throw. iframe `src`에 토큰을 넣지 않는다.
- `postMessage`는 `{ source: "aura-widget", event, payload }`다. 송신 `targetOrigin`은 상대 origin이고 `*`를 쓰지 않는다.
- 호스트 수신부는 `event.origin === helpdeskOrigin`만 통과한다. 호스트 `window.location.origin`과 비교하지 않는다(위젯은 교차 origin이다).
- 프레임 수신부는 쿼리 `parent_origin`(http/https origin)과 `event.origin`이 같을 때만 통과한다. `ready` 뒤에 호스트가 `init{ token, inboxId }`를 보낸다. API·WS base는 `window.location.origin`이다.
- `setUser`는 `identifier_hash`가 있을 때만 `POST /public/api/v1/inboxes/{inbox_id}/identify`로 보낸다. 서버가 `HMAC-SHA256(identifier, inbox hmac_secret)` 소문자 hex를 검증한다. identify는 현재 컨택트에 identifier만 쓴다. 익명이고 같은 identifier가 있으면 `contact_merged`로 티켓만 옮기고 대화 id는 유지한다. 식별된 충돌은 거절. 시크릿은 SDK에 없고 호스트 서버만 가진다. 복사·회전은 SPA administrator.
- Contact `pubsub_token`은 시드다. 프레임이 `POST /public/api/v1/inboxes/{inbox_id}/auth`로 짧은 만료 접근 토큰을 받는다. `private` 메시지는 그리지 않는다.

## Commands

저장소 루트 기준.

```sh
cd packages/widget-sdk
npm test
```

호스트 예: `window.$aura = run({ baseUrl, inboxId, token })`. `token`은 Contact `pubsub_token` 시드.
