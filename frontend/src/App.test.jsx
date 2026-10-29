import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { App } from "./App.jsx";
import { fixtureState } from "./store.js";

afterEach(() => cleanup());

const session = { accountId: "acc", token: "tok", gatewayUrl: "" };

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
