# frontend

상담원 SPA. 컴포넌트 간 계약은 [ARCHITECTURE.md](../ARCHITECTURE.md). 공간 배치·토큰·ARIA 불변은 [docs/UI_UX_레이아웃_설계안.md](../docs/UI_UX_레이아웃_설계안.md). P5.5부터 Rail + 3-Pane(큐/스레드/컨텍스트) 4-Zone. Living Profile 내용은 P7.

## 내부 설계

- PG에 붙지 않는다. `POST /auth/sign_in`으로 세션 쿠키를 받고 `access_token`을 메모리에 둔다. WS·Application API는 그 Bearer만 쓴다. 쿠키는 JS가 읽지 않는다. 부트스트랩은 `POST /auth/refresh`로 쿠키가 있으면 토큰을 복구한다. HTTP 401은 single-flight refresh 후 같은 요청을 재시도하고, 새 토큰은 `session`과 WS에 같이 넣는다. WS가 닫히면 refresh로 재연결한다.
- UI는 Tailwind CSS v4 시맨틱 토큰 + `src/components/ui` shadcn new-york primitives (`Button`/`Input`/`Textarea`/`Label`/`Badge`/`Card`, `cn`은 `clsx`+`tailwind-merge`). 레거시 `#ddd` 보더·`font-family: sans-serif`를 두지 않는다. 전역 스토어(Zustand/Redux)는 두지 않는다. 큐는 `store.js` reduce. `message.created` upsert는 기존 대화의 `status`/`version`/`assigneeId`/`snoozedUntil`/`labels`/`slaBreached`를 유지한다.
- 셸은 `100vw × 100dvh`를 Rail(56px) · Queue(320px, `nav[aria-label="대기열"]`) · Thread(`flex-1`, min 480px, 헤더 52px + `ol[role="log"]` + 통합 컴포저) · Context(300px)로 나눈다. `>=1280px` 4영역, `1024–1279px` 컨텍스트는 `dialog[aria-label="고객 정보"]` 드로어, `<1024px`는 큐↔스레드(`대기열로`). 레일은 이니셜 아바타+가용 도트·인박스 unread·`?` 단축키·로그아웃(`DELETE /auth/sign_out`). 큐 카드는 채널(Web/Kakao/Email)·`#displayId`·고객명·상대시각·SLA 보더 / lastContent / 라벨·unread. 헤더는 `#displayId`·고객명·채널·상태 시맨틱 배지(open emerald / pending amber / snoozed slate). 헤더 담당자/스누즈/매크로는 `details[name="thread-actions"]`로 하나만 열고 `Escape`로 닫는다. 타임라인은 고객 `bg-slate-100` 좌측 버블·상담원 우측 버블·내부 메모 앰버이고 새 메시지는 맨 아래로 스크롤한다. 첨부는 클립 아이콘(`첨부 파일`)과 `열기` 카드이고 이미지는 썸네일. 내부 메모 캡션은 `상담원에게만 보임`. 컨텍스트는 고객 프로필·라벨·채널/`#REQ-`·카카오 30일·SLA 잔여. 설정은 인박스 멤버/HMAC/카탈로그 탭이고 인박스는 `session.inboxIds` Select(`aria-label="인박스"`)로 고른다. 상담원 추가는 다른 인박스 멤버 합집합 Select(`aria-label="상담원"`) + `상담원 ID` 폴백이다. Select가 있으면 UUID 인풋(`인박스 ID`/`상담원 ID`/`담당자 ID`)은 `field-fallback`으로 숨기고 ARIA 이름은 유지한다. 로그인·큐 카드·배정·메모·스누즈·라벨·첨부·저장응답·매크로·해결은 이 primitives만 쓰고, [App.test.jsx](src/App.test.jsx) accessible name은 유지한다.
- 부트스트랩 후 `GET .../conversations`로 큐를 채우고, 선택 시 `GET .../messages`로 스레드를 채운다. 목록 JSON의 `contact_name`·`last_activity_at`·`applied_slas`가 큐·컨텍스트를 채운다. 목록 GET 기본은 `resolved`를 제외한다. 담당자 쿼리는 두지 않는다. 큐는 `helpdesk.realtime`의 `message.created`로 upsert한다. 같은 `messages.id`는 무시하고, 같은 내용의 `pending-*` 낙관적 버블은 서버 id로 교체한다. 선택하지 않은 대화는 unread를 올린다. `resolved`는 큐에서 숨긴다. `pending`은 큐에 남긴다. `sla_breached`면 큐 카드에 SLA 뱃지를 단다. 큐 카드는 채널·티켓번호·시각 / lastContent / 라벨·unread 3행이다.
- 답장은 `POST /api/v1/accounts/{account_id}/conversations/{id}/messages`에 `inbox_id`·`contact_id`·`contact_inbox_id`를 넣는다(게이트웨이가 대화 행을 조회하지 않음). 전송은 낙관적이다: 로컬 `pending-*` 버블을 `status: "sending"`(투명도 70%)로 즉시 붙이고 실패하면 `재전송`을 보여 준다. 서버 `message_id` 또는 같은 내용의 `message.created`가 오면 pending을 교체한다. 배정은 인박스 멤버 Select(+ 나에게 배정)로 고르는 즉시 `PUT .../assignee`. 내부 메모는 `POST .../notes`이고 답장과 같이 낙관적 버블(`재전송`)을 쓰되 큐 lastContent를 바꾸지 않는다. 스누즈는 프리셋(1시간 뒤·오늘 오후 6시·내일 09:00·다음 주 월요일)을 누르면 바로 `PUT .../snooze`하고, `datetime-local` 폴백은 RFC3339로 바꿔 같은 API를 쓴다. HMAC은 보기 전에 `••••••••`로 가리고 복사하면 `복사됨`을 보여 준다. 비이미지 첨부는 📄 아이콘이다. `status=snoozed`이면서 `snoozedUntil`이 아직 미래면 큐에서 숨긴다. 라벨은 컨텍스트 패널에서 카탈로그 칩을 누르거나 datalist로 이름을 고르고 `POST .../conversations/{id}/labels`로 부착, `DELETE .../labels/{label_id}`로 조인만 뗀다. 카탈로그 `POST .../labels`와 저장응답·공유 매크로 생성(`매크로 저장`)·인박스 멤버·HMAC은 administrator 설정 뷰. `나에게 배정`은 바로 `PUT .../assignee`한다. 첨부 크기는 1024B 이상이면 KB다. 통합 컴포저는 답장/메모 탭 + 클립·드롭·붙여넣기 즉시 첨부(`첨부` 버튼은 폴백) + `/short_code` 팝오버(`ul[role="listbox"][aria-label="저장응답"]`, 화살표·Enter로 고르고 Escape로 `/` 토큰을 지운다). 인박스·담당자 native `select`는 시맨틱 보더 토큰을 쓴다. 답장 placeholder는 `/ 를 입력해 저장응답 삽입`이다. 매크로 실행은 스레드 헤더에서 `POST .../macros/{id}/execute`하고, `⌘K`는 메뉴를 연 뒤 첫 `실행`에 포커스한다. administrator의 생성 폼은 헤더에 두지 않는다. 첨부는 `POST .../attachments` multipart `file`이다. 해결 영역은 `PUT .../status`로 `pending` 또는 `resolved`다. `pending`은 큐에 남고 `resolved`만 숨긴다.
- 로컬 개발은 Vite가 `/auth`·`/api`·`/ws`를 `gateway-web(:8080)`으로 프록시한다. 브라우저 CORS를 게이트웨이에 열지 않는다.
- 부트스트랩: 로그인 화면. 레일에서 대기열과 설정(administrator만)을 가른다. Agent는 시크릿을 보지 않는다. 설정 탭은 인박스 멤버/HMAC/카탈로그/웹훅/리포트/도움말. 리포트는 CSAT%와 SLA hit rate. 웹훅 URL·구독 등록. 도움말은 `articles` 작성. `?fixture=1`은 WS 없이 큐·스레드를 채운다. 컨텍스트 패널은 라벨·채널·SLA와 Living Profile(`section[aria-label="Living Profile"]`, PainPoint rose / Product blue / Preference emerald / Feature violet). 스레드 `content_type=form`은 도구 승인 카드(`[승인 및 실행]` → `POST .../tools/{execution_id}/approve`). 셸·브레이크포인트는 P5.5 그대로다. Mine/미배정/라벨 폴더·URL 딥링크는 출시 후. 단축키 `J`/`K`/`R`/`N`/`⌘Enter`/`E`/`⌘K`(매크로).

## Commands

저장소 루트 기준.

```sh
cd frontend
npm test
npm run dev
```

프록시 대상은 `127.0.0.1:8080`. `go run ./cmd/gateway-web`이 떠 있어야 실WS가 붙는다.
