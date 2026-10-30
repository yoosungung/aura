import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { App } from "./App.jsx";
import { fixtureState } from "./store.js";

afterEach(() => cleanup());

const session = { accountId: "acc", token: "tok", gatewayUrl: "" };

test("login screen is a shadcn card", async () => {
  const { container } = render(
    <App
      session={{ accountId: "", token: "", gatewayUrl: "" }}
      client={{
        async refresh() {
          throw new Error("offline");
        },
      }}
    />,
  );
  await screen.findByRole("form", { name: "로그인" });
  expect(container.querySelector('[data-slot="card"]')).toBeTruthy();
  expect(container.querySelector('[data-slot="button"]')).toBeTruthy();
});

test("queue uses badge and thread composer uses textarea", async () => {
  const user = userEvent.setup();
  const { container } = render(
    <App session={session} client={{ connect() {} }} initialState={fixtureState()} />,
  );
  expect(container.querySelector('[data-slot="badge"]')?.textContent).toBe("1");
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  expect(screen.getByLabelText("답장").tagName).toBe("TEXTAREA");
});

test("failed refresh shows the login form", async () => {
  render(
    <App
      session={{ accountId: "", token: "", gatewayUrl: "" }}
      client={{
        async refresh() {
          throw new Error("offline");
        },
      }}
    />,
  );
  expect(await screen.findByRole("form", { name: "로그인" })).toBeTruthy();
});

test("login form signs in and shows the queue", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={{ accountId: "", token: "", gatewayUrl: "" }}
      client={{
        async signIn() {
          return { access_token: "tok", user: { account_id: "acc" } };
        },
      }}
    />,
  );
  await user.type(screen.getByLabelText("이메일"), "ada@acme.test");
  await user.type(screen.getByLabelText("비밀번호"), "s3cret");
  await user.click(screen.getByRole("button", { name: "로그인" }));
  expect(screen.getByRole("navigation", { name: "대기열" })).toBeTruthy();
});

test("selecting a queue card shows the thread", async () => {
  const user = userEvent.setup();
  render(
    <App session={session} client={{ connect() {} }} initialState={fixtureState()} />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  expect(screen.getByRole("log").textContent).toContain("결제 오류");
});

test("administrator can add an inbox member", async () => {
  const user = userEvent.setup();
  const added = [];
  render(
    <App
      session={{ ...session, role: "administrator", inboxIds: ["i1"] }}
      client={{
        connect() {},
        async listInboxMembers() {
          return { members: [] };
        },
        async addInboxMember(req) {
          added.push(req);
        },
      }}
    />,
  );
  expect(screen.getByRole("region", { name: "인박스 멤버" })).toBeTruthy();
  await user.type(screen.getByLabelText("상담원 ID"), "user-1");
  await user.click(screen.getByRole("button", { name: "추가" }));
  expect(added[0].userId).toBe("user-1");
  expect(added[0].inboxId).toBe("i1");
});

test("agent does not see inbox member admin", () => {
  render(
    <App session={{ ...session, role: "agent" }} client={{ connect() {} }} />,
  );
  expect(screen.queryByRole("region", { name: "인박스 멤버" })).toBeNull();
});

test("ticket view assigns to an inbox agent", async () => {
  const user = userEvent.setup();
  const assigned = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async assignConversation(req) {
          assigned.push(req);
          return { assignee_id: "user-1", status: "open", version: 2 };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("담당자 ID"), "user-1");
  await user.click(screen.getByRole("button", { name: "배정" }));
  expect(assigned[0].assigneeId).toBe("user-1");
  expect(assigned[0].conversationId).toBe("c1");
  expect(assigned[0].expectedVersion).toBe(1);
});

test("ticket view posts an internal note", async () => {
  const user = userEvent.setup();
  const notes = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async sendNote(req) {
          notes.push(req);
          return { message_id: "n1", content: req.content, private: true };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("메모"), "환불 검토");
  await user.click(screen.getByRole("button", { name: "메모" }));
  expect(notes[0].content).toBe("환불 검토");
  expect(notes[0].conversationId).toBe("c1");
  expect(screen.getByRole("log").textContent).toContain("환불 검토");
});

test("ticket view attaches a label by name", async () => {
  const user = userEvent.setup();
  const labeled = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async addConversationLabel(req) {
          labeled.push(req);
          return { id: "l1", name: req.name };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("라벨 이름"), "환불");
  await user.click(screen.getByRole("button", { name: "부착" }));
  expect(labeled[0].conversationId).toBe("c1");
  expect(labeled[0].name).toBe("환불");
  expect(screen.getByRole("region", { name: "티켓 라벨" }).textContent).toContain("환불");
});

test("ticket view keeps a note and a label on the same thread", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={session}
      client={{
        connect() {},
        async sendNote(req) {
          return { message_id: "n1", content: req.content };
        },
        async addConversationLabel(req) {
          return { id: "l1", name: req.name };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("메모"), "환불 검토");
  await user.click(screen.getByRole("button", { name: "메모" }));
  await user.type(screen.getByLabelText("라벨 이름"), "환불");
  await user.click(screen.getByRole("button", { name: "부착" }));
  expect(screen.getByRole("log").textContent).toContain("환불 검토");
  expect(screen.getByRole("region", { name: "티켓 라벨" }).textContent).toContain("환불");
});

test("ticket view snoozes and hides the card until then", async () => {
  const user = userEvent.setup();
  const snoozed = [];
  const until = new Date(Date.now() + 3600_000).toISOString();
  render(
    <App
      session={session}
      client={{
        connect() {},
        async snoozeConversation(req) {
          snoozed.push(req);
          return { status: "snoozed", version: 2, snoozed_until: until };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("스누즈 시각"), until);
  await user.click(screen.getByRole("button", { name: "스누즈" }));
  expect(snoozed[0].conversationId).toBe("c1");
  expect(snoozed[0].snoozedUntil).toBe(until);
  expect(screen.queryByRole("button", { name: /결제 오류/ })).toBeNull();
  expect(screen.getByText("대기 중인 대화가 없습니다")).toBeTruthy();
});

test("ticket view uploads an attachment", async () => {
  const user = userEvent.setup();
  const uploaded = [];
  const file = new File(["pngdata"], "receipt.png", { type: "image/png" });
  render(
    <App
      session={session}
      client={{
        connect() {},
        async uploadAttachment(req) {
          uploaded.push(req);
          return {
            message_id: "m2",
            attachments: [
              {
                id: "a1",
                file_type: "image",
                external_url: "http://127.0.0.1:8888/acc/a1/receipt.png",
                file_size: 7,
              },
            ],
          };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.upload(screen.getByLabelText("첨부 파일"), file);
  await user.click(screen.getByRole("button", { name: "첨부" }));
  expect(uploaded[0].conversation.id).toBe("c1");
  expect(uploaded[0].file.name).toBe("receipt.png");
  expect(screen.getByRole("log").textContent).toContain("receipt.png");
  expect(screen.getByRole("log").textContent).toContain("http://127.0.0.1:8888/acc/a1/receipt.png");
});

test("ticket view keeps a note, a label, and an attachment on the same thread", async () => {
  const user = userEvent.setup();
  const file = new File(["pngdata"], "receipt.png", { type: "image/png" });
  render(
    <App
      session={session}
      client={{
        connect() {},
        async sendNote(req) {
          return { message_id: "n1", content: req.content };
        },
        async addConversationLabel(req) {
          return { id: "l1", name: req.name };
        },
        async uploadAttachment() {
          return {
            message_id: "m2",
            attachments: [
              { id: "a1", file_type: "image", external_url: "http://filer/receipt.png", file_size: 7 },
            ],
          };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("메모"), "환불 검토");
  await user.click(screen.getByRole("button", { name: "메모" }));
  await user.type(screen.getByLabelText("라벨 이름"), "환불");
  await user.click(screen.getByRole("button", { name: "부착" }));
  await user.upload(screen.getByLabelText("첨부 파일"), file);
  await user.click(screen.getByRole("button", { name: "첨부" }));
  expect(screen.getByRole("log").textContent).toContain("환불 검토");
  expect(screen.getByRole("region", { name: "티켓 라벨" }).textContent).toContain("환불");
  expect(screen.getByRole("log").textContent).toContain("receipt.png");
});

test("ticket view removes an attached label", async () => {
  const user = userEvent.setup();
  const removed = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async addConversationLabel(req) {
          return { id: "l1", name: req.name };
        },
        async removeConversationLabel(req) {
          removed.push(req);
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("라벨 이름"), "환불");
  await user.click(screen.getByRole("button", { name: "부착" }));
  await user.click(screen.getByRole("button", { name: "제거" }));
  expect(removed[0].labelId).toBe("l1");
  expect(screen.getByRole("region", { name: "티켓 라벨" }).textContent).not.toContain("환불");
});

test("workspace hydrates the queue from the conversation list", async () => {
  render(
    <App
      session={session}
      client={{
        connect() {},
        async listConversations() {
          return {
            conversations: [
              {
                id: "c9",
                inbox_id: "i1",
                contact_id: "p1",
                contact_inbox_id: "ci1",
                last_content: "배송 문의",
                status: "open",
                version: 1,
              },
            ],
          };
        },
      }}
    />,
  );
  expect(await screen.findByRole("button", { name: /배송 문의/ })).toBeTruthy();
});

test("ticket view marks pending and keeps the card", async () => {
  const user = userEvent.setup();
  const moved = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async resolveConversation(req) {
          moved.push(req);
          return { status: req.newStatus, version: 2 };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.click(screen.getByRole("button", { name: "대기" }));
  expect(moved[0].newStatus).toBe("pending");
  expect(screen.getByRole("button", { name: /결제 오류/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "해결" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "대기" })).toBeNull();
});

test("ticket view resolves and hides the card", async () => {
  const user = userEvent.setup();
  const resolved = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async resolveConversation(req) {
          resolved.push(req);
          return { status: "resolved", version: 2 };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.click(screen.getByRole("button", { name: "해결" }));
  expect(resolved[0].conversationId).toBe("c1");
  expect(screen.queryByRole("button", { name: /결제 오류/ })).toBeNull();
  expect(screen.getByText("대기 중인 대화가 없습니다")).toBeTruthy();
});

test("queue shows attached label badges", async () => {
  render(
    <App
      session={session}
      client={{ connect() {} }}
      initialState={{
        ...fixtureState(),
        conversations: [{ ...fixtureState().conversations[0], labels: [{ id: "l1", name: "환불" }] }],
      }}
    />,
  );
  expect(screen.getByRole("button", { name: /환불/ }).textContent).toContain("환불");
});

test("composer inserts a canned response from slash", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={session}
      client={{
        connect() {},
        async listCanned() {
          return { canned_responses: [{ id: "r1", short_code: "인사", content: "안녕하세요" }] };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("답장"), "/인사");
  await user.click(screen.getByRole("button", { name: "/인사" }));
  expect(screen.getByLabelText("답장").value).toBe("안녕하세요");
});

test("ticket view runs a macro", async () => {
  const user = userEvent.setup();
  const ran = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async listMacros() {
          return { macros: [{ id: "m1", name: "환불 완료" }] };
        },
        async executeMacro(req) {
          ran.push(req);
          return {
            labels: [{ id: "l1", name: "환불" }],
            messages: [{ message_id: "m9", content: "환불이 완료되었습니다.", private: false }],
          };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.click(screen.getByRole("button", { name: "실행" }));
  expect(ran[0].macroId).toBe("m1");
  expect(screen.getByRole("log").textContent).toContain("환불이 완료되었습니다.");
  expect(screen.getByRole("region", { name: "티켓 라벨" }).textContent).toContain("환불");
});

test("administrator adds a catalog label", async () => {
  const user = userEvent.setup();
  const created = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listAccountLabels() {
          return { labels: [] };
        },
        async listCanned() {
          return { canned_responses: [] };
        },
        async createAccountLabel(req) {
          created.push(req);
          return { id: "l9", name: req.name };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.type(screen.getByLabelText("카탈로그 라벨"), "결제");
  await user.click(screen.getByRole("button", { name: "라벨 추가" }));
  expect(created[0].name).toBe("결제");
  expect(screen.getByRole("region", { name: "카탈로그" }).textContent).toContain("결제");
});

test("reply posts through the gateway client", async () => {
  const user = userEvent.setup();
  const sent = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async sendReply(req) {
          sent.push(req);
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("답장"), "확인했습니다");
  await user.click(screen.getByRole("button", { name: "보내기" }));
  expect(sent[0].content).toBe("확인했습니다");
  expect(sent[0].conversation.id).toBe("c1");
});
