# frontend

상담원 SPA. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md). P2는 3-Pane 중 좌(큐)·중(스레드)만.

## 내부 설계

- PG에 붙지 않는다. `POST /auth/sign_in`으로 세션 쿠키를 받고 `access_token`을 메모리에 둔다. WS·Application API는 그 Bearer만 쓴다. 쿠키는 JS가 읽지 않는다. 부트스트랩은 `POST /auth/refresh`로 쿠키가 있으면 토큰을 복구한다.
- UI는 Tailwind CSS v4 + `src/components/ui` shadcn 스타일 primitives. 전역 스토어(Zustand/Redux)는 두지 않는다. 큐는 `store.js` reduce.
- 대화 목록 REST는 아직 없다. 큐는 `helpdesk.realtime`의 `message.created`로 upsert한다. 같은 `messages.id`는 무시한다. 선택하지 않은 대화는 unread를 올린다.
- 답장은 `POST /api/v1/accounts/{account_id}/conversations/{id}/messages`에 `inbox_id`·`contact_id`·`contact_inbox_id`를 넣는다(게이트웨이가 대화 행을 조회하지 않음). 스레드에서 담당자 ID로 `PUT .../assignee` 수동 배정한다. 내부 메모는 `POST .../notes`이고 큐 lastContent를 바꾸지 않는다. 스누즈는 `PUT .../snooze`이고 `status=snoozed`이면서 `snoozedUntil`이 아직 미래면 큐에서 숨긴다.
- 로컬 개발은 Vite가 `/auth`·`/api`·`/ws`를 `gateway-web(:8080)`으로 프록시한다. 브라우저 CORS를 게이트웨이에 열지 않는다.
- 부트스트랩: 로그인 화면. `administrator`는 큐 아래 인박스 멤버 추가 UI를 본다. `?fixture=1`은 WS 없이 큐·스레드를 채운다. 우측 Living Profile은 P7.

## Commands

저장소 루트 기준.

```sh
cd frontend
npm test
npm run dev
```

프록시 대상은 `127.0.0.1:8080`. `go run ./cmd/gateway-web`이 떠 있어야 실WS가 붙는다.
