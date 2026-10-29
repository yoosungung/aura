# frontend

상담원 SPA. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md). P2는 3-Pane 중 좌(큐)·중(스레드)만.

## 내부 설계

- PG에 붙지 않는다. User HMAC 토큰으로 `gateway-web` WS·Application API만 호출한다. 로그인/OIDC는 P3.
- 대화 목록 REST는 아직 없다. 큐는 `helpdesk.realtime`의 `message.created`로 upsert한다. 같은 `messages.id`는 무시한다. 선택하지 않은 대화는 unread를 올린다.
- 답장은 `POST /api/v1/accounts/{account_id}/conversations/{id}/messages`에 `inbox_id`·`contact_id`·`contact_inbox_id`를 넣는다(게이트웨이가 대화 행을 조회하지 않음).
- 로컬 개발은 Vite가 `/api`·`/ws`를 `gateway-web(:8080)`으로 프록시한다. 브라우저 CORS를 게이트웨이에 열지 않는다.
- 부트스트랩: `?account_id=&token=` 또는 `VITE_ACCOUNT_ID`/`VITE_TOKEN`. `?fixture=1`은 WS 없이 큐·스레드를 채운다. 우측 Living Profile은 P7.

## Commands

저장소 루트 기준.

```sh
cd frontend
npm test
npm run dev
```

프록시 대상은 `127.0.0.1:8080`. `go run ./cmd/gateway-web`이 떠 있어야 실WS가 붙는다.
