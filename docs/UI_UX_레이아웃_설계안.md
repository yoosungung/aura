# Aura UI/UX 레이아웃 및 인터랙션 설계안 (10년 표준 아키텍처)

본 문서는 [`frontend/`](../frontend/)(상담원·관리자 워크스페이스 SPA)와 [`packages/widget-sdk/`](../packages/widget-sdk/)(고객용 라이브챗 위젯)의 **UI/UX 공간 배치(Spatial Layout), 컴포넌트 계층, 시각 토큰, 키보드 인터랙션 및 접근성(ARIA) 명세**다.

선도적인 엔터프라이즈 생산성 도구(Linear, Front, Intercom, Channel Talk)의 **고밀도·저피로도(High-Density, Low-Fatigue)** 설계 원칙을 따르며, P2~P7 로드맵(옴니채널, SLA Breach, CSAT, AI Ego-Graph Living Profile, 도구 승인 카드)이 레이아웃 변경 없이 자연스럽게 안착하도록 설계한다.

---

## 1. 핵심 설계 원칙 (Design Principles)

1. **대화 중심 공간 배분 (Conversation-First Viewport)**:
   * 뷰포트(`100vw × 100dvh`)에서 **메시지 타임라인(`role="log"`)과 통합 컴포저가 항상 중앙 영역 높이와 면적의 75% 이상**을 차지해야 한다.
   * 티켓 조작(배정, 스누즈, 상태 전이, 매크로)은 상단 `52px` 단일 헤더 바의 인라인 컨트롤·팝오버로 압축하고, 메타데이터(라벨, 고객 프로필, Ego-Graph)는 우측 컨텍스트 패널(`300px`)로 분리한다.
2. **상담 워크스페이스와 관리자 설정의 분리 (Workspace vs. Admin Isolation)**:
   * 관리자 전용 폼(인박스 멤버, HMAC 시크릿, 라벨 카탈로그, 저장응답, 공유 매크로 빌더)을 실시간 대기열(`nav.queue`) 안에 세로로 쌓지 않는다. 좌측 네비게이션 레일(또는 설정 드로어/탭)을 통해 전용 설정 영역에서 다룬다.
3. **시맨틱 컬러 신호 (Zero-Ambiguity Visual Cues)**:
   * **대고객 답장(Public Reply)** 과 **내부 메모(Private Note)** 는 에디터 배경색과 전송 버튼 색상 단계에서 완전히 달라야 한다(답장: `White/Zinc`, 메모: `Amber-50/Amber-600`). 상담원이 내부 메모를 실수로 고객에게 발송하는 사고를 시각적으로 차단한다.
   * **SLA 위반(`sla_breached`)** 과 **세션 만료 임박(카카오 30일 창)** 은 즉시 눈에 띄는 시맨틱 배지(`Destructive Red` / `Warning Amber`)로 표시한다.
4. **키보드 퍼스트 & 접근성 계약 유지 (Keyboard-First & ARIA Contract)**:
   * 모든 주요 액션은 마우스 없이 키보드 단축키와 시맨틱 ARIA 역할(`role="navigation"`, `role="log"`, `role="region"`, `role="listbox"`)로 접근 가능해야 하며, 기존 TDD 테스트 스위트([`App.test.jsx`](../frontend/src/App.test.jsx))의 접근성 셀렉터와 100% 호환된다.

---

## 2. 상담원 SPA (`frontend/`) 전체 레이아웃 구조 (4-Zone Shell)

뷰포트 전체(`100vw × 100dvh`, `overflow: hidden`)를 **좌측 레일(Rail) + 3-Pane(Queue / Thread / Context)** 의 4개 수직 영역으로 분할한다.

```
+------+----------------------+---------------------------------------------+------------------------+
| Rail |     Queue Pane       |                 Thread Pane                 |      Context Pane      |
| 56px |       320px          |              flex-1 (min 480px)             |         300px          |
+------+----------------------+---------------------------------------------+------------------------+
| [🟢] | 대기열          [필터]| #1042 결제 오류 문의  [Web] [Open] | [배정][스누즈][매크로][대기][해결] | 고객 프로필             |
|      |----------------------|---------------------------------------------| 홍길동 (ada@acme.test) |
| [📥] | [전체 12][미배정 4]   |                                             |------------------------|
| 큐   |----------------------| [고객] 안녕하세요, 결제 오류가 납니다. 14:20 | 티켓 라벨              |
|      | ● #1042 결제 오류     |                                             | [환불 ×] [VIP ×]       |
| [⚙️] |   [SLA] [환불]   [2] |          [상담원] 확인 후 안내드리겠습니다. | [라벨 추가...    ][부착]|
| 설정 |----------------------|          [📎 receipt.png (7KB)]       14:22 |------------------------|
|      |   #1041 배송 문의     |                                             | SLA 상태 (P5)          |
|      |   [Kakao]            | 🔒 [내부 메모] 결제 PG사 로그 확인 필요     | FRT: 충족 / RT: 18분 남음|
|      |----------------------|---------------------------------------------|------------------------|
|      |                      | 🤖 [AI 승인 요청] 결제 취소 실행 (₩45,000)  | Living Profile (P7)    |
|      |                      |    [승인 및 실행]  [거절]                   | • [PainPoint] 결제오류  |
|      |                      |---------------------------------------------| • [Product] Pro 플랜   |
|      |                      | [답장 (Reply)] [🔒 내부 메모 (Note)]        | • [Pref] 이메일 선호    |
| [👤] |                      | +-----------------------------------------+ |                        |
| 상태 |                      | | /인사 입력 시 팝오버 자동완성...        | |                        |
|      |                      | | [📎 첨부]                    [보내기 ⏎] | |                        |
|      |                      | +-----------------------------------------+ |                        |
+------+----------------------+---------------------------------------------+------------------------+
```

### 반응형 브레이크포인트 규칙
| 화면 너비 | 레이아웃 동작 |
|---|---|
| `>= 1280px` (Desktop) | `Rail(56px)` + `Queue(320px)` + `Thread(flex-1)` + `Context(300px)` 4개 영역 모두 표시 |
| `1024px ~ 1279px` (Laptop) | `Context(300px)`를 우측 슬라이드오버 드로어(토글 버튼)로 접고 `Rail + Queue + Thread` 표시 |
| `< 1024px` (Tablet/Mobile) | 대화 미선택 시 `Queue` 전체 화면, 대화 선택 시 `Thread` 전체 화면 (`← 대기열로` 뒤로가기 버튼 노출) |

---

## 3. 영역별 상세 컴포넌트 명세

### 3.1 Zone 1: 글로벌 네비게이션 레일 (`aside.rail`, 너비 `56px`)

좌측 끝에 고정되어 상담원의 현재 작업 모드와 온라인 상태를 제어한다.

* **상단**:
  * **브랜드 로고 & 상담원 가용 상태 표시기**: 아바타 우측 하단에 상태 도트 표시 (`online`: Emerald-500, `busy`: Amber-500, `offline`: Slate-400).
  * **워크스페이스 전환 탭**:
    * `대기열 (Inbox)` 아이콘 버튼 (읽지 않은 총 메시지 수 배지 표시)
    * `설정 (Settings)` 아이콘 버튼 (`session.role === "administrator"`일 때만 노출, 클릭 시 설정 드로어/모달 또는 설정 뷰 열기)
* **하단**:
  * 로그아웃(`DELETE /auth/sign_out`) 버튼.

---

### 3.2 Zone 2: 대화 대기열 패널 (`nav[aria-label="대기열"]`, 너비 `320px`)

수백 개의 활성 티켓을 스캔하고 우선순위가 높은 티켓을 즉시 골라내는 영역이다.

#### ① 대기열 헤더 & 필터 바
* 타이틀 `<h1>대기열</h1>` 및 현재 활성 티켓 수 카운트 표시.
* 상태/할당 필터 탭 (출시 후 URL 쿼리와 연동): `전체` · `내 담당` · `미배정` · `대기(Pending)`.

#### ② 큐 카드 (Queue Card) 해부도
각 `<li>` 아이템 내부의 `<Button variant="ghost">`는 단순 1줄 텍스트가 아니라 **3행 마이크로 그리드** 구조를 가진다.

```
+--------------------------------------------------+
| [Web] #1042 · 고객명              [SLA]   2분 전 |  <-- Row 1: 채널 아이콘, 티켓 번호, SLA 배지, 시각
| 결제 오류입니다. 카드 승인이 거절됩니다...       |  <-- Row 2: lastContent (1~2줄 말줄임, line-clamp-2)
| [환불] [긴급]                              ( 2 ) |  <-- Row 3: 부착된 라벨 배지 목록 + 우측 Unread 카운트
+--------------------------------------------------+
```

* **선택 상태 스타일**: `aria-current="true"`일 때 좌측 `3px` 프라이머리 인디케이터 바(`border-l-3 border-zinc-900 bg-zinc-100/80`) 적용.
* **SLA 위반 강조 (`c.slaBreached === true`)**: `<Badge variant="destructive">SLA</Badge>`를 카드 우측 상단에 노출하고 카드 좌측 보더에 붉은 틴트를 부여한다.

---

### 3.3 Zone 3: 중앙 스레드 패널 (`section.thread`, `flex-1`)

중앙 패널은 **상단 헤더 바 (`52px` 고정)** + **메시지 타임라인 (`flex-1`, 스크롤)** + **하단 통합 컴포저 (가변 높이)** 의 3단 수직 Flex 레이아웃(`flex flex-col h-full min-w-0`)으로 구성한다.

#### ① 상단 스레드 헤더 & 액션 툴바 (`header.thread-header`)
기존에 세로로 나열되던 [`AssignTicket`](../frontend/src/components/AssignTicket.jsx), [`SnoozeTicket`](../frontend/src/components/SnoozeTicket.jsx), [`TicketMacros`](../frontend/src/components/TicketMacros.jsx), [`ResolveTicket`](../frontend/src/components/ResolveTicket.jsx)을 **높이 `52px`의 단일 수평 툴바** 안에 인라인 배치한다.

```
+---------------------------------------------------------------------------------------------------+
| #1042 [Open]                              | [?] [👤 담당자 ▾] [⏰ 스누즈 ▾] [⚡ 매크로 ▾] | [대기] [✓ 해결] |
+---------------------------------------------------------------------------------------------------+
```

* **담당자 배정 (`AssignTicket`)**:
  * 헤더 내 컴팩트 폼/팝오버로 배치. 인박스 소속 상담원 드롭다운(또는 `담당자 ID` 입력 + `배정` 버튼)을 한 줄(`flex items-center gap-1.5`)로 정렬.
* **스누즈 (`SnoozeTicket`)**:
  * 빠른 프리셋 칩(`+1시간`, `내일 09:00`)과 직접 입력 인풋(`스누즈 시각` + `스누즈` 버튼)을 컴팩트 툴바 그룹으로 배치.
* **매크로 (`TicketMacros`)**:
  * 저장된 매크로 목록을 툴바 내 칩/드롭다운으로 노출하고 즉시 `실행` 가능하게 배치. 새 매크로 생성 폼은 ` [+ 매크로 만들기]` 토글(또는 설정 패널) 안에 접어두어 기본 대화 화면을 가리지 않게 한다.
* **상태 전이 (`ResolveTicket`)**:
  * 우측 끝에 `대기`(`variant="outline"`, `status !== "pending"`일 때만 노출) 버튼과 `해결`(`variant="default"`, 프라이머리 강조) 버튼을 나란히 배치한다.
* **단축키 도움말(`?`)**:
  * 레일에 두지 않는다. 대기열에서 대화를 선택한 뒤에만 스레드 헤더에 노출한다. `?` 키도 같은 조건에서만 연다.

#### ② 메시지 타임라인 (`ol[role="log"]`)
배경은 눈의 피로를 줄이는 미세한 오프화이트(`bg-slate-50/60`)로 두고, 메시지 성격에 따라 5가지 레이아웃으로 렌더링한다.

```
  [고객 메시지 - 좌측 정렬]
  +----------------------------------------+
  | 결제 오류가 계속 발생합니다.           |
  | 14:20                                  |
  +----------------------------------------+

                            [상담원 답장 - 우측 정렬]
                            +----------------------------------------+
                            | 확인 후 바로 처리해 드리겠습니다.      |
                            | +------------------------------------+ |
                            | | 🖼 receipt.png (7 B)        [열기] | |
                            | +------------------------------------+ |
                            | 14:22 · 전송됨                         |
                            +----------------------------------------+

          [내부 메모 (data-private="true") - 중앙/우측 앰버 노트 박스]
          +----------------------------------------------------------+
          | 🔒 내부 메모 (상담원에게만 보임)                         |
          | 환불 검토 — PG사 거래번호 #TX-9981 확인 완료             |
          +----------------------------------------------------------+
```

| 메시지 유형 | 조건 | 정렬 및 컨테이너 스타일 |
|---|---|---|
| **고객 메시지 (Incoming)** | `senderType === "Contact"` | 좌측 정렬 (`mr-auto max-w-[72%]`), `bg-white border border-slate-200 text-slate-900 rounded-2xl rounded-tl-sm px-4 py-2.5 shadow-2xs` |
| **상담원 답장 (Outgoing)** | `senderType === "User" && !private` | 우측 정렬 (`ml-auto max-w-[72%]`), `bg-zinc-900 text-zinc-50 rounded-2xl rounded-tr-sm px-4 py-2.5 shadow-2xs` |
| **내부 메모 (Private Note)** | `private === true` | 우측/전체 폭 (`ml-auto max-w-[80%]`), `bg-amber-50/90 border border-amber-300/80 text-amber-950 rounded-xl px-4 py-2.5` + 상단 `🔒 내부 메모` 배지 |
| **첨부파일 (Attachment)** | `m.attachments.length > 0` | 메시지 버블 내부 하단에 파일 카드(`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs`)로 링크 렌더링 |
| **AI 초안 / 도구 승인 카드 (P7)** | `senderType === "AgentBot"` / `requires_approval` | 보라/인디고 보더 카드(`bg-indigo-50/60 border-indigo-200`) + 입력 인자(`input_args`) 요약 + `[승인]` / `[거절]` 액션 버튼 |

#### ③ 하단 통합 컴포저 영역 (Unified Composer Dock)
스레드 하단에 고정(`border-t bg-white p-3`)되며, **답장 에디터 + 내부 메모 + 파일 첨부 + `/` 저장응답 자동완성**을 하나의 일관된 도크(Dock) 안에 배치한다.

```
+---------------------------------------------------------------------------------------------------+
| [💬 답장]  [🔒 내부 메모]                                              [📎 파일 첨부]             |
|---------------------------------------------------------------------------------------------------|
| (저장응답 자동완성 팝오버 - / 입력 시 상단 플로팅)                                                |
| +-----------------------------------------------------------------------------------------------+ |
| | [/인사] 안녕하세요, 무엇을 도와드릴까요?                                                      | |
| +-----------------------------------------------------------------------------------------------+ |
|                                                                                                   |
| 답장 또는 내부 메모 입력... (/ 를 입력해 저장응답 삽입)                                           |
|                                                                                                   |
|---------------------------------------------------------------------------------------------------|
| receipt.png [첨부]                                                       [메모 작성]  [보내기 ⏎]  |
+---------------------------------------------------------------------------------------------------+
```

* **내부 메모 모드**: 도크 배경·에디터·전송 버튼만 앰버다. 폼 구조는 답장과 같다(`form.note`: textarea `aria-label="메모"` + 버튼 `"메모"`). 설정 폼처럼 라벨을 쌓지 않는다.
* **`/` 슬래시 저장응답 리스트박스 (`ul[role="listbox"][aria-label="저장응답"]`)**:
  * 에디터 레이아웃을 밀어내지 않도록 컴포저 상단에 `position: absolute; bottom: 100%` 팝오버 카드(`bg-white border shadow-lg rounded-lg p-1`)로 띄운다.
  * 각 항목 클릭 시 `/short_code` 토큰을 본문으로 즉시 치환한다.

---

### 3.4 Zone 4: 우측 컨텍스트 패널 (`aside.context-pane`, 너비 `300px`)

대화 스레드를 방해하지 않고 티켓 분류와 고객 맥락(Living Profile)을 한눈에 파악·조작하는 패널이다.

1. **티켓 라벨 섹션 (`section[aria-label="티켓 라벨"]`)**:
   * 현재 부착된 라벨 칩 목록(`Badge` + `제거` 버튼)을 Flex-wrap으로 표시.
   * 하단에 `라벨 이름` 자동완성 인풋(`list="account-labels"`)과 `부착` 버튼을 인라인 배치.
2. **채널 및 세션 상태 카드 (P4/P5)**:
   * 웹 / 이메일(`#REQ-{display_id}`) / 카카오 상담톡(마지막 고객 메시지 기준 30일 세션 타이머 표시).
   * 적용된 SLA 정책(`applied_slas`)의 FRT / NRT / RT 목표 시각 및 잔여 시간 표시.
3. **고객 Living Profile — Ego-Graph (P7)**:
   * `ontology_nodes` / `ontology_edges`에서 조회한 1~2홉 엔티티를 카테고리별 칩으로 시각화:
     * `PainPoint` (Rose 배지), `Product` (Blue 배지), `Preference` (Emerald 배지), `Feature` (Violet 배지).

---

### 3.5 관리자 설정 패널 (`session.role === "administrator"`)

관리자로 로그인했을 때 대기열을 가로막지 않도록 레일 `설정`으로 **전용 설정 뷰**를 연다. `section[aria-label="워크스페이스 관리"]`는 좌측 그룹 내비(`nav[aria-label="설정 메뉴"]`, 176px)와 본문(`div.settings-body`)으로 나눈다. P5.5 셸(Rail/Queue/Thread/Context) 폭은 바꾸지 않는다.

```
+------+------------------+--------------------------------------------------------+
| Rail | 설정 메뉴 176px  | 본문 (max 40rem)                                       |
+------+------------------+--------------------------------------------------------+
| 설정 | 인박스           | h2 + 목록(행 액션) + 생성/수정 폼                      |
|      |  인박스 멤버     |                                                        |
|      |  HMAC 시크릿     |                                                        |
|      | 콘텐츠           |                                                        |
|      |  저장응답        |                                                        |
|      |  라벨            |                                                        |
|      |  매크로          |                                                        |
|      |  도움말          |                                                        |
|      | 연동             |                                                        |
|      |  웹훅            |                                                        |
|      |  MCP             |                                                        |
|      |  Agent Skills    |                                                        |
|      | 분석             |                                                        |
|      |  리포트          |                                                        |
+------+------------------+--------------------------------------------------------+
```

* `section[aria-label="인박스 멤버"]`: 인박스별 소속 상담원 조회 및 추가.
* `section[aria-label="HMAC 시크릿"]`: 시크릿 마스킹(`••••••••`), `보기` 클릭 시 노출, `복사`, `재발급` 즉시 회전.
* `section[aria-label="저장응답"]`: `short_code` + `저장응답` + `저장응답 추가`. 목록에서 고르면 폼에 채워 수정, 행 삭제. 저장 버튼은 `settings-form-actions`에서 작게 오른쪽 정렬.
* `section[aria-label="라벨"]`: 계정 공통 라벨(`카탈로그 라벨` + `라벨 추가`). 목록에서 고르면 폼에 채워 수정, 행 삭제. 저장 버튼은 `settings-form-actions`에서 작게 오른쪽 정렬.
* `section[aria-label="매크로"]`: 공유 매크로(`매크로 이름` + `공개 메시지` + `매크로 저장`). 목록에서 고르면 폼에 채워 수정, 행 삭제. 저장 버튼은 `settings-form-actions`에서 작게 오른쪽 정렬.
* `section[aria-label="도움말"]`: Help Center 문서 제목·slug·본문. 목록에서 고르면 폼에 채워 수정, 행 삭제.
* `section[aria-label="웹훅"]`: 아웃바운드 URL 등록(`message_created`)·행 삭제.
* `section[aria-label="MCP"]`: 운영계 MCP 목록에서 고르면 upsert, 행 삭제. `auth_header`는 보기 전 `••••••••`, `재발급`은 고른 서버(없으면 첫 행).
* `section[aria-label="Agent Skills"]`: 목록에서 고르면 폼에 채워 upsert, 행 삭제.
* `section[aria-label="리포트"]`: CSAT%·SLA 막대, 대화 상태 도넛, 상담원·인박스 가로 막대. `GET /reports` 현재 수치만.

---

## 4. 고객용 라이브챗 위젯 (`packages/widget-sdk/`) UI/UX 레이아웃 설계

외부 호스트 웹사이트의 우측 하단(`position: fixed; bottom: 20px; right: 20px; z-index: 2147483000`)에 마운트되며, **호스트 페이지의 클릭을 가로채지 않는(Zero Pointer-Trap) 2-State 리사이즈 레이아웃**을 따른다.

```
[State A: 닫힘 (Closed) — 60×60px]          [State B: 열림 (Open) — 380×640px (모바일 100vw×100dvh)]
                                           +----------------------------------------+
                                           | 💬 Aura 고객센터                 [✕]   | <-- Header (56px)
                                           |    보통 5분 내 응답합니다              |
                                           +----------------------------------------+
                                           | [상담원] 안녕하세요! 무엇을 도와드릴까요| <-- Message List
                                           |                                        |     (#messages, flex-1)
                                           |              [고객] 결제 문의드립니다. |
                                           |                                        |
                                           | +------------------------------------+ |
                                           | | ⭐ 상담 만족도를 평가해 주세요 (P5)| | <-- CSAT Card
                                           | |   [1]  [2]  [3]  [4]  [5]          | |     (input_csat)
                                           | +------------------------------------+ |
+--------+                                 +----------------------------------------+
|  💬  1 |                                 | [ 메시지를 입력하세요...      ] [전송] | <-- Composer (60px)
+--------+                                 +----------------------------------------+
 (60x60px)
```

### 위젯 크기 및 포지셔닝 계약
| 상태 | iframe CSS 치수 | 호스트 페이지 영향 |
|---|---|---|
| **Closed (`open: false`)** | 런처 전용 모드 시 `width: 60px; height: 60px; border-radius: 9999px;` 또는 `display: none`(호스트 버튼 사용 시) | 우측 하단 `60×60px` 외 호스트 버튼 클릭 간섭 0% |
| **Open — Desktop (`>= 480px`)** | `width: 380px; height: min(640px, calc(100dvh - 40px)); border-radius: 16px; box-shadow: 0 20px 50px rgba(0,0,0,0.16);` | 우측 하단 플로팅 메신저 |
| **Open — Mobile (`< 480px`)** | `inset: 0; width: 100vw; height: 100dvh; border-radius: 0;` | 모바일 키보드 올라올 때 `100dvh`로 뷰포트 자동 대응 |

---

## 5. 디자인 토큰 명세 (Design Tokens — Tailwind v4 기준)

[`frontend/src/styles.css`](../frontend/src/styles.css)에서 사용하는 색상·타이포그래피·간격 표준이다.

### 5.1 컬러 팔레트 (Semantic Surface & Status)
| 토큰 역할 | Tailwind 클래스 / HEX | 사용처 |
|---|---|---|
| **App Canvas** | `bg-slate-50` (`#f8fafc`) | 스레드 타임라인 배경, 설정 배경 |
| **Panel Surface** | `bg-white` (`#ffffff`) | 대기열 패널, 스레드 헤더, 컴포저, 컨텍스트 패널 |
| **Border Hairline** | `border-slate-200` (`#e2e8f0`) | 패널 간 1px 구분선 (`#ddd` 하드코딩 대체) |
| **Primary Interactive** | `bg-zinc-900 text-white` (`#18181b`) | 상담원 발신 버블, 주요 액션 버튼(`보내기`, `해결`) |
| **Internal Note (Private)** | `bg-amber-50 border-amber-300 text-amber-950` | 내부 메모 버블 및 내부 메모 작성 영역 |
| **SLA Breached / Danger** | `bg-rose-50 text-rose-700 border-rose-200` | 큐 카드 `SLA` 배지, 에러 알림(`role="alert"`) |
| **Status: Open** | `bg-emerald-50 text-emerald-700` | 활성 대화 상태 배지 |
| **Status: Pending / Snoozed** | `bg-amber-50 text-amber-700` / `bg-slate-100 text-slate-600` | 고객 대기 / 스누즈 상태 배지 |

### 5.2 타이포그래피 & 밀도
* ** 기본 폰트 패밀리**: `"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif`
* **큐 카드 타이틀 / 본문**: `text-sm (14px) font-medium text-slate-900` / 프리뷰 `text-xs (12px) text-slate-500 line-clamp-1`
* **메시지 버블 본문**: `text-sm (14px) leading-relaxed (1.6) whitespace-pre-wrap break-words`
* **메타 라벨 / 배지**: `text-[11px] font-medium tracking-tight`

---

## 6. TDD 테스트 스위트([`App.test.jsx`](../frontend/src/App.test.jsx)) 호환성 매핑표 (불변 ARIA 계약)

레이아웃과 디자인을 전면 개편하더라도 아래 **시맨틱 역할(Role)과 라벨(Label) 계약은 절대 깨뜨리지 않는다.**

| 영역 / 기능 | 필수 DOM Role / Attribute | 필수 Accessible Name (`aria-label` / 텍스트) | 검증 테스트 ([`App.test.jsx`](../frontend/src/App.test.jsx)) |
|---|---|---|---|
| 로그인 폼 | `form`, `[data-slot="card"]` | `aria-label="로그인"`, 입력: `"이메일"`, `"비밀번호"`, 버튼: `"로그인"` | L11–L67 |
| 대기열 네비게이션 | `nav` (`role="navigation"`) | `aria-label="대기열"`, 빈 상태: `"대기 중인 대화가 없습니다"` | L66, L261, L437 |
| 큐 카드 & 배지 | `button`, `[data-slot="badge"]` | 대화 `lastContent`, 라벨명, `SLA` 배지, `unread` 숫자 | L27–L35, L389–L391, L440–L452 |
| 메시지 타임라인 | `ol` (`role="log"`) | 각 `li`에 `data-sender`, 내부 메모는 `data-private="true"` | L75, L185, L296, L499 |
| 티켓 배정 | `form` (`class="assign"`) | `aria-label="티켓 배정"`, 입력: `"담당자 ID"`, 버튼: `"배정"` | L140–L162 |
| 티켓 스누즈 | `form` (`class="snooze"`) | `aria-label="티켓 스누즈"`, 입력: `"스누즈 시각"`, 버튼: `"스누즈"` | L238–L262 |
| 티켓 해결 / 대기 | `div` (`class="resolve"`) | `aria-label="티켓 해결"`, 버튼: `"대기"`, `"해결"` | L393–L438 |
| 티켓 라벨 (우측 패널) | `section` (`role="region"`) | `aria-label="티켓 라벨"`, 입력: `"라벨 이름"`, 버튼: `"부착"`, `"제거"` | L188–L210, L338–L362 |
| 매크로 툴바 | `section` (`role="region"`) | `aria-label="매크로"`, 버튼: `"실행"`, `"매크로 저장"` | L474–L501 |
| 파일 첨부 | `form` (`class="attachments"`) | `aria-label="파일 첨부"`, 입력: `"첨부 파일"`, 버튼: `"첨부"` | L264–L298 |
| 내부 메모 | `form` (`class="note"`) | `aria-label="내부 메모"`, 입력: `"메모"`, 버튼: `"메모"` | L164–L186 |
| 답장 컴포저 & `/` 저장응답 | `form` (`class="composer"`) | `Textarea`: `aria-label="답장"`, 자동완성 `ul[role="listbox"][aria-label="저장응답"]`, 버튼: `"보내기"` | L34, L454–L472, L531–L551 |
| 관리자: 인박스 멤버 | `section` (`role="region"`) | `aria-label="인박스 멤버"`, 입력: `"인박스 ID"`, `"상담원 ID"`, 버튼: `"추가"` | L78–L108 |
| 관리자: HMAC 시크릿 | `section` (`role="region"`) | `aria-label="HMAC 시크릿"`, 버튼: `"보기"`, `"복사"`, `"재발급"` | L110–L138 |
| 관리자: 설정 내비 | `nav` (`aria-label="설정 메뉴"`) | 그룹 제목 `"인박스"`/`"콘텐츠"`/`"연동"`/`"분석"`, 버튼 순서: `"인박스 멤버"`/`"HMAC 시크릿"`/`"저장응답"`/`"라벨"`/`"매크로"`/`"도움말"`/`"웹훅"`/`"MCP"`/`"Agent Skills"`/`"리포트"` | 설정 그룹 내비 테스트 |
| 관리자: 저장응답 | `section` (`role="region"`) | `aria-label="저장응답"`, 입력: `"short_code"`/`"저장응답"`, 버튼: `"저장응답 추가"`, `"삭제"` | 카탈로그 등록·삭제 테스트 |
| 관리자: 라벨 | `section` (`role="region"`) | `aria-label="라벨"`, 입력: `"카탈로그 라벨"`, 버튼: `"라벨 추가"`, `"삭제"` | 카탈로그 등록·삭제 테스트 |
| 관리자: 매크로 설정 | `section` (`role="region"`) | `aria-label="매크로"`, 입력: `"매크로 이름"`/`"공개 메시지"`, 버튼: `"매크로 저장"`, `"삭제"` | 카탈로그 등록·삭제 테스트 |
| 관리자: 웹훅 | `section` (`role="region"`) | `aria-label="웹훅"`, 입력: `"웹훅 URL"`, 버튼: `"웹훅 추가"`, `"삭제"` | 웹훅 등록·삭제 테스트 |
| 관리자: 도움말 | `section` (`role="region"`) | `aria-label="도움말"`, 입력: `"문서 제목"`/`"slug"`/`"본문"`, 버튼: `"문서 게시"`, `"삭제"` | 문서 게시·삭제 테스트 |
| 관리자: MCP | `section` (`role="region"`) | `aria-label="MCP"`, 입력: `"MCP 이름"`/`"MCP URL"`/`"인증 헤더"`, 버튼: `"MCP 추가"`/`"보기"`/`"재발급"`/`"삭제"` | MCP 등록·회전·삭제 테스트 |
| 관리자: Agent Skills | `section` (`role="region"`) | `aria-label="Agent Skills"`, 입력: `"스킬 이름"`/`"스킬 설명"`/`"스킬 본문"`, 버튼: `"스킬 저장"`, `"삭제"` | Skills 저장·수정·삭제 테스트 |
