# frontend

상담원 SPA. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md). 공간 배치·토큰·ARIA 불변은 [docs/UI_UX_레이아웃_설계안.md](../docs/UI_UX_레이아웃_설계안.md). P5.5부터 Rail + 3-Pane(큐/스레드/컨텍스트) 4-Zone. Living Profile 내용은 P7.

## 내부 설계

- PG에 붙지 않는다. `POST /auth/sign_in`으로 세션 쿠키를 받고 `access_token`을 메모리에 둔다. WS·Application API는 그 Bearer만 쓴다. 쿠키는 JS가 읽지 않는다. 부트스트랩은 `POST /auth/refresh`로 쿠키가 있으면 토큰을 복구한다. HTTP 401은 single-flight refresh 후 같은 요청을 재시도하고, 새 토큰은 `session`과 WS에 같이 넣는다. WS가 닫히면 refresh로 재연결한다.
- UI는 Tailwind CSS v4 시맨틱 토큰 + `src/components/ui` shadcn new-york primitives (`Button`/`Input`/`Textarea`/`Label`/`Badge`/`Card`, `cn`은 `clsx`+`tailwind-merge`). 레거시 `#ddd` 보더·`font-family: sans-serif`를 두지 않는다. 전역 스토어(Zustand/Redux)는 두지 않는다. 큐는 `store.js` reduce. `message.created` upsert는 기존 대화의 `status`/`version`/`assigneeId`/`snoozedUntil`/`labels`/`slaBreached`를 유지한다.
- 셸은 `100vw × 100dvh`를 Rail(56px) · Queue(320px, `nav[aria-label="대기열"]`) · Thread(`flex-1`, 헤더 52px + `ol[role="log"]` + 통합 컴포저) · Context(300px)로 나눈다. `>=1280px` 4영역, `1024–1279px` 컨텍스트 드로어, `<1024px` 큐↔스레드. 로그인·큐 카드·배정·메모·스누즈·라벨·첨부·저장응답·매크로·해결은 이 primitives만 쓰고, [App.test.jsx](src/App.test.jsx) accessible name은 유지한다.
- 부트스트랩 후 `GET .../conversations`로 큐를 채우고, 선택 시 `GET .../messages`로 스레드를 채운다. 목록 GET 기본은 `resolved`를 제외한다. 담당자 쿼리는 두지 않는다. 큐는 `helpdesk.realtime`의 `message.created`로 upsert한다. 같은 `messages.id`는 무시한다. 선택하지 않은 대화는 unread를 올린다. `resolved`는 큐에서 숨긴다. `pending`은 큐에 남긴다. `sla_breached`면 큐 카드에 SLA 뱃지를 단다. 큐 카드는 채널·티켓번호·시각 / lastContent / 라벨·unread 3행이다.
- 답장은 `POST /api/v1/accounts/{account_id}/conversations/{id}/messages`에 `inbox_id`·`contact_id`·`contact_inbox_id`를 넣는다(게이트웨이가 대화 행을 조회하지 않음). 배정은 인박스 멤버 Select(+ 나에게 배정)로 `PUT .../assignee`. 내부 메모는 `POST .../notes`이고 큐 lastContent를 바꾸지 않는다. 스누즈는 프리셋 또는 `datetime-local`을 RFC3339로 바꿔 `PUT .../snooze`하고, `status=snoozed`이면서 `snoozedUntil`이 아직 미래면 큐에서 숨긴다. 라벨은 컨텍스트 패널에서 계정 카탈로그를 datalist로 고르고 `POST .../conversations/{id}/labels`로 부착, `DELETE .../labels/{label_id}`로 조인만 뗀다. 카탈로그 `POST .../labels`와 저장응답·공유 매크로 생성·인박스 멤버·HMAC은 administrator 설정 뷰. 통합 컴포저는 답장/메모 탭 + 첨부 + `/short_code` 팝오버(`ul[role="listbox"][aria-label="저장응답"]`). 매크로는 스레드 헤더에서 `POST .../macros/{id}/execute`. 첨부는 `POST .../attachments` multipart `file`이다. 해결 영역은 `PUT .../status`로 `pending` 또는 `resolved`다. `pending`은 큐에 남고 `resolved`만 숨긴다.
- 로컬 개발은 Vite가 `/auth`·`/api`·`/ws`를 `gateway-web(:8080)`으로 프록시한다. 브라우저 CORS를 게이트웨이에 열지 않는다.
- 부트스트랩: 로그인 화면. 레일에서 대기열과 설정(administrator만)을 가른다. Agent는 시크릿을 보지 않는다. `?fixture=1`은 WS 없이 큐·스레드를 채운다. 컨텍스트 패널은 라벨·채널·SLA. Living Profile은 P7. Mine/미배정/라벨 폴더·URL 딥링크는 출시 후. 단축키 `J`/`K`/`R`/`N`/`⌘Enter`/`E`.

## Commands

저장소 루트 기준.

```sh
cd frontend
npm test
npm run dev
```

프록시 대상은 `127.0.0.1:8080`. `go run ./cmd/gateway-web`이 떠 있어야 실WS가 붙는다.
