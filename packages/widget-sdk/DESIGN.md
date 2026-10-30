# widget-sdk

외부 사이트에 붙는 라이브챗 위젯. 컴포넌트 간 계약은 [ARCHITECTURE.md](../../ARCHITECTURE.md) §7. 공간 배치는 [docs/UI_UX_레이아웃_설계안.md](../../docs/UI_UX_레이아웃_설계안.md) §4.

## 내부 설계

- 호스트는 로더만 실행한다. 런처(60×60, 안 읽은 배지)는 호스트 Shadow DOM이다. 본체는 `{helpdeskOrigin}/widget.html` 교차출처 iframe이고, **열림일 때만** 표시한다. 닫힘에서 iframe이 호스트 클릭을 가로채지 않는다. 열림은 데스크톱 `380×640`(높이 `min(640px, 100dvh - 40px)`, `border-radius: 16px`, `box-shadow: 0 20px 50px rgba(0,0,0,0.16)`), 모바일(`<480px`) `100vw×100dvh`(호스트 `visualViewport.height`가 있으면 그 픽셀로 키보드에 맞춤). 패널은 헤더 56px(`💬 Aura 고객센터` / `보통 5분 내 응답합니다`) + `#messages[role=log]` + 컴포저 60px. 고객(`Contact`) 버블은 우측 `고객` 캡션, 상담원(`User`)은 좌측 `상담원` 캡션. `input_csat`는 ⭐ 1–5 카드다.
- `baseUrl`은 `http`/`https`만 받고 origin만 쓴다. `javascript:`·`data:`는 throw. iframe `src`에 토큰을 넣지 않는다.
- `postMessage`는 `{ source: "aura-widget", event, payload }`다. 송신 `targetOrigin`은 상대 origin이고 `*`를 쓰지 않는다. 런처 클릭은 `open`/`close`, 프레임은 `ready`/`resize`/`unread`/`close`.
- 호스트 수신부는 `event.origin === helpdeskOrigin`만 통과한다. 호스트 `window.location.origin`과 비교하지 않는다(위젯은 교차 origin이다).
- 프레임 수신부는 쿼리 `parent_origin`(http/https origin)과 `event.origin`이 같을 때만 통과한다. `ready` 뒤에 호스트가 `init{ token, inboxId }`를 보낸다. API·WS base는 `window.location.origin`이다.
- `setUser`는 `identifier_hash`가 있을 때만 `POST /public/api/v1/inboxes/{inbox_id}/identify`로 보낸다. 서버가 `HMAC-SHA256(identifier, inbox hmac_secret)` 소문자 hex를 검증한다. identify는 현재 컨택트에 identifier만 쓴다. 익명이고 같은 identifier가 있으면 `contact_merged`로 티켓만 옮기고 대화 id는 유지한다. 식별된 충돌은 거절. 시크릿은 SDK에 없고 호스트 서버만 가진다. 복사·회전은 SPA administrator.
- Contact `pubsub_token`은 시드다. `init` 직후(및 만료 시) 프레임이 `POST /public/api/v1/inboxes/{inbox_id}/auth`로 짧은 만료 접근 토큰을 받아 Bearer·WS에만 쓴다. `send`마다 소켓을 열지 않는다. `OPEN`/`CONNECTING`이면 재사용하고, 토큰이 바뀌면 기존 소켓을 닫은 뒤 연다. `private` 메시지는 그리지 않는다. resolved 후 `content_type=input_csat`이면 1–5 버튼을 그리고 `POST /public/api/v1/inboxes/{inbox_id}/csat`로 보낸다.

## Commands

저장소 루트 기준.

```sh
cd packages/widget-sdk
npm test
```

iframe 엔트리는 `{helpdeskOrigin}/widget.html`(게이트웨이 `AURA_WIDGET_DIR`). 호스트는 `sdk.js`의 `run({ baseUrl, inboxId, token })`.

호스트 예: `window.$aura = run({ baseUrl, inboxId, token })`. `token`은 Contact `pubsub_token` 시드.
