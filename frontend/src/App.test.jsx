import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { App } from "./App.js";
import { fixtureState } from "./store.js";

if (typeof window !== "undefined") {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
}

afterEach(() => cleanup());

const session = { accountId: "acc", token: "tok", gatewayUrl: "" };

async function openHeaderMenu(user, name) {
  await user.click(screen.getByText(name, { selector: "summary" }));
}

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

test("contact messages use a slate incoming bubble", async () => {
  const user = userEvent.setup();
  render(
    <App session={session} client={{ connect() {} }} initialState={fixtureState()} />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  expect(document.querySelector(".bubble-in").className).toMatch(/slate-100/);
});

test("administrator settings live behind the rail", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={{ ...session, role: "administrator", inboxIds: ["i1"] }}
      client={{
        connect() {},
        async listInboxMembers() {
          return { members: [] };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  expect(screen.getByRole("navigation", { name: "대기열" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "인박스 멤버" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "설정" }));
  expect(screen.getByRole("region", { name: "인박스 멤버" })).toBeTruthy();
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
  await user.click(screen.getByRole("button", { name: "설정" }));
  expect(screen.getByRole("region", { name: "인박스 멤버" })).toBeTruthy();
  await user.type(screen.getByLabelText("상담원 ID"), "user-1");
  await user.click(screen.getByRole("button", { name: "추가" }));
  expect(added[0].userId).toBe("user-1");
  expect(added[0].inboxId).toBe("i1");
});

test("administrator picks an agent from other inbox members", async () => {
  const user = userEvent.setup();
  const added = [];
  render(
    <App
      session={{ ...session, role: "administrator", inboxIds: ["i1", "i2"] }}
      client={{
        connect() {},
        async listInboxMembers(req) {
          if (req.inboxId === "i2") {
            return { members: [{ user_id: "user-2", name: "Bee", email: "bee@acme.test" }] };
          }
          return { members: [] };
        },
        async addInboxMember(req) {
          added.push(req);
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "상담원" }), "user-2");
  expect(screen.getByLabelText("상담원 ID").value).toBe("user-2");
  expect(screen.getByLabelText("상담원 ID").closest("label").className).toMatch(/field-fallback/);
  await user.click(screen.getByRole("button", { name: "추가" }));
  expect(added[0].userId).toBe("user-2");
  expect(added[0].inboxId).toBe("i1");
});

test("administrator picks inbox from a session select", async () => {
  const user = userEvent.setup();
  const added = [];
  const seen = [];
  render(
    <App
      session={{ ...session, role: "administrator", inboxIds: ["i1", "i2"] }}
      client={{
        connect() {},
        async listInboxMembers() {
          return { members: [] };
        },
        async addInboxMember(req) {
          added.push(req);
        },
        async getInbox(req) {
          seen.push(req.inboxId);
          return { hmac_secret: "secret" };
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "인박스" }), "i2");
  expect(screen.getByLabelText("인박스 ID").value).toBe("i2");
  expect(screen.getByLabelText("인박스 ID").closest("label").className).toMatch(/field-fallback/);
  await user.type(screen.getByLabelText("상담원 ID"), "user-1");
  await user.click(screen.getByRole("button", { name: "추가" }));
  expect(added[0].inboxId).toBe("i2");
  await user.click(screen.getByRole("button", { name: "HMAC 시크릿" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "인박스" }), "i2");
  await user.click(screen.getByRole("button", { name: "보기" }));
  expect(seen[0]).toBe("i2");
});

test("agent does not see inbox member admin", () => {
  render(
    <App session={{ ...session, role: "agent" }} client={{ connect() {} }} />,
  );
  expect(screen.queryByRole("region", { name: "인박스 멤버" })).toBeNull();
  expect(screen.queryByRole("region", { name: "HMAC 시크릿" })).toBeNull();
});

test("administrator reveals and rotates inbox hmac secret", async () => {
  const user = userEvent.setup();
  const rotated = [];
  render(
    <App
      session={{ ...session, role: "administrator", inboxIds: ["i1"] }}
      client={{
        connect() {},
        async listInboxMembers() {
          return { members: [] };
        },
        async getInbox() {
          return { hmac_secret: "secret" };
        },
        async rotateHmac(req) {
          rotated.push(req);
          return { hmac_secret: "newsecret" };
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "HMAC 시크릿" }));
  expect(screen.getByRole("region", { name: "HMAC 시크릿" })).toBeTruthy();
  expect(screen.getByText("••••••••")).toBeTruthy();
  expect(screen.queryByText("secret")).toBeNull();
  await user.click(screen.getByRole("button", { name: "보기" }));
  expect(screen.getByText("secret")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "재발급" }));
  expect(rotated[0].inboxId).toBe("i1");
  expect(screen.getByText("newsecret")).toBeTruthy();
  const copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => copied.push(text) },
  });
  await user.click(screen.getByRole("button", { name: "복사" }));
  expect(copied[0]).toBe("newsecret");
  expect(screen.getByText("복사됨")).toBeTruthy();
});

test("administrator saves inbox greeting and hours", async () => {
  const user = userEvent.setup();
  const saved = [];
  render(
    <App
      session={{ ...session, role: "administrator", inboxIds: ["i1"] }}
      client={{
        connect() {},
        async listInboxMembers() {
          return { members: [] };
        },
        async getInbox() {
          return { hmac_secret: "secret", greeting_message: "", business_hours_enabled: false, business_hours: {} };
        },
        async updateInbox(req) {
          saved.push(req);
          return {
            hmac_secret: "secret",
            greeting_message: req.greetingMessage,
            business_hours_enabled: req.businessHoursEnabled,
            business_hours: req.businessHours,
          };
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "HMAC 시크릿" }));
  await user.type(screen.getByLabelText("부재중 인사"), "부재중입니다");
  await user.click(screen.getByLabelText("영업시간 사용"));
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saved[0].greetingMessage).toBe("부재중입니다");
  expect(saved[0].businessHoursEnabled).toBe(true);
  expect(screen.getByText("저장됨")).toBeTruthy();
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
  await openHeaderMenu(user, "담당자");
  await user.type(screen.getByLabelText("담당자 ID"), "user-1");
  await user.click(screen.getByRole("button", { name: "배정" }));
  expect(assigned[0].assigneeId).toBe("user-1");
  expect(assigned[0].conversationId).toBe("c1");
  expect(assigned[0].expectedVersion).toBe(1);
});

test("assign to me submits immediately", async () => {
  const user = userEvent.setup();
  const assigned = [];
  render(
    <App
      session={{ ...session, userId: "me" }}
      client={{
        connect() {},
        async assignConversation(req) {
          assigned.push(req);
          return { assignee_id: req.assigneeId, status: "open", version: 2 };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await openHeaderMenu(user, "담당자");
  await user.click(screen.getByRole("button", { name: "나에게 배정" }));
  expect(assigned[0].assigneeId).toBe("me");
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
  await user.click(screen.getByRole("button", { name: "내부 메모" }));
  await user.type(screen.getByLabelText("메모"), "환불 검토");
  await user.click(screen.getByRole("button", { name: "메모" }));
  expect(notes[0].content).toBe("환불 검토");
  expect(notes[0].conversationId).toBe("c1");
  expect(screen.getByRole("log").textContent).toContain("환불 검토");
  expect(screen.getByRole("button", { name: /결제 오류/ }).textContent).not.toContain("환불 검토");
});

test("failed note shows a retry control", async () => {
  const user = userEvent.setup();
  const notes = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async sendNote(req) {
          notes.push(req);
          if (notes.length === 1) {
            throw new Error("offline");
          }
          return { message_id: "n9", content: req.content, private: true };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.click(screen.getByRole("button", { name: "내부 메모" }));
  await user.type(screen.getByLabelText("메모"), "환불 검토");
  await user.click(screen.getByRole("button", { name: "메모" }));
  expect(screen.getByRole("log").textContent).toContain("환불 검토");
  expect(screen.getByRole("button", { name: "재전송" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "재전송" }));
  expect(notes).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "재전송" })).toBeNull();
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

test("ticket view attaches a catalog label chip", async () => {
  const user = userEvent.setup();
  const labeled = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async listAccountLabels() {
          return { labels: [{ id: "l9", name: "VIP" }] };
        },
        async addConversationLabel(req) {
          labeled.push(req);
          return { id: "l9", name: req.name };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.click(await screen.findByRole("button", { name: "VIP" }));
  expect(labeled[0].name).toBe("VIP");
  expect(screen.getByRole("region", { name: "티켓 라벨" }).textContent).toContain("VIP");
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
  await user.click(screen.getByRole("button", { name: "내부 메모" }));
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
  const wake = new Date(Date.now() + 3_600_000);
  const pad = (n) => String(n).padStart(2, "0");
  const until = `${wake.getFullYear()}-${pad(wake.getMonth() + 1)}-${pad(wake.getDate())}T${pad(wake.getHours())}:${pad(wake.getMinutes())}`;
  render(
    <App
      session={session}
      client={{
        connect() {},
        async snoozeConversation(req) {
          snoozed.push(req);
          return { status: "snoozed", version: 2, snoozed_until: req.snoozedUntil };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await openHeaderMenu(user, "스누즈");
  await user.type(screen.getByLabelText("스누즈 시각"), until);
  await user.click(screen.getByRole("button", { name: "스누즈" }));
  expect(snoozed[0].conversationId).toBe("c1");
  expect(snoozed[0].snoozedUntil).toBe(new Date(until).toISOString());
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
  expect(uploaded[0].conversation.id).toBe("c1");
  expect(uploaded[0].file.name).toBe("receipt.png");
  expect(screen.getByRole("log").textContent).toContain("receipt.png");
  const attach = screen.getByRole("link", { name: /receipt.png/ });
  expect(attach.getAttribute("href")).toContain("http://127.0.0.1:8888/acc/a1/receipt.png");
  expect(attach.textContent).toContain("열기");
  expect(attach.querySelector("img")?.getAttribute("src")).toContain("receipt.png");
  expect(document.querySelector(".attach-clip")).toBeTruthy();
});

test("composer dock drop and paste attach a file", async () => {
  const user = userEvent.setup();
  const uploaded = [];
  const file = new File(["pngdata"], "drop.png", { type: "image/png" });
  render(
    <App
      session={session}
      client={{
        connect() {},
        async uploadAttachment(req) {
          uploaded.push(req);
          return {
            message_id: "m2",
            attachments: [{ id: "a1", file_type: "image", file_name: req.file.name, external_url: "http://filer/drop.png" }],
          };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  fireEvent.drop(document.querySelector(".composer-dock"), {
    dataTransfer: { files: [file], types: ["Files"] },
  });
  expect(uploaded[0].file.name).toBe("drop.png");
  const pasted = new File(["pngdata"], "paste.png", { type: "image/png" });
  fireEvent.paste(screen.getByLabelText("답장"), {
    clipboardData: { files: [pasted] },
  });
  expect(uploaded[1].file.name).toBe("paste.png");
});

test("non-image attachments show a document icon", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={session}
      client={{ connect() {} }}
      initialState={{
        ...fixtureState(),
        selectedId: "c1",
        messages: {
          c1: [
            {
              id: "m1",
              content: "로그",
              senderType: "Contact",
              attachments: [
                {
                  id: "a2",
                  file_type: "application/pdf",
                  file_name: "trace.pdf",
                  external_url: "http://filer/trace.pdf",
                  file_size: 2048,
                },
              ],
            },
          ],
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  expect(screen.getByRole("link", { name: /trace.pdf/ }).textContent).toContain("📄");
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
  await user.click(screen.getByRole("button", { name: "내부 메모" }));
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
                sla_breached: true,
              },
            ],
          };
        },
      }}
    />,
  );
  expect(await screen.findByRole("button", { name: /배송 문의/ })).toBeTruthy();
  expect(screen.getByText("SLA")).toBeTruthy();
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
  expect(screen.getByLabelText("답장").getAttribute("placeholder")).toMatch(/저장응답/);
  await user.type(screen.getByLabelText("답장"), "/인사");
  await user.keyboard("{Enter}");
  expect(screen.getByLabelText("답장").value).toBe("안녕하세요");
});

test("composer listbox arrows pick a canned response", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={session}
      client={{
        connect() {},
        async listCanned() {
          return {
            canned_responses: [
              { id: "r1", short_code: "인사", content: "안녕하세요" },
              { id: "r2", short_code: "인원", content: "인원 확인했습니다" },
            ],
          };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("답장"), "/인");
  const reply = screen.getByLabelText("답장");
  expect(reply.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("option", { name: "/인사" }).getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "/인원" }).getAttribute("aria-selected")).toBe("true");
  expect(reply.getAttribute("aria-activedescendant")).toBe("canned-r2");
  await user.keyboard("{Enter}");
  expect(reply.value).toBe("인원 확인했습니다");
});

test("escape dismisses the canned slash token", async () => {
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
  expect(screen.getByRole("listbox", { name: "저장응답" })).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox", { name: "저장응답" })).toBeNull();
  expect(screen.getByLabelText("답장").value).toBe("");
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
  await openHeaderMenu(user, "매크로");
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
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "카탈로그" }));
  await user.type(screen.getByLabelText("카탈로그 라벨"), "결제");
  await user.click(screen.getByRole("button", { name: "라벨 추가" }));
  expect(created[0].name).toBe("결제");
  expect(screen.getByRole("region", { name: "카탈로그" }).textContent).toContain("결제");
});

test("administrator deletes catalog labels canned and macros", async () => {
  const user = userEvent.setup();
  const deleted = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listAccountLabels() {
          return { labels: [{ id: "l1", name: "결제" }] };
        },
        async listCanned() {
          return { canned_responses: [{ id: "c1", short_code: "인사" }] };
        },
        async listMacros() {
          return { macros: [{ id: "m1", name: "공유" }] };
        },
        async deleteAccountLabel(req) {
          deleted.push(["label", req.labelId]);
        },
        async deleteCanned(req) {
          deleted.push(["canned", req.canned_id]);
        },
        async deleteMacro(req) {
          deleted.push(["macro", req.macroId]);
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "카탈로그" }));
  const catalog = await screen.findByRole("region", { name: "카탈로그" });
  expect(catalog.textContent).toContain("결제");
  const buttons = within(catalog).getAllByRole("button", { name: "삭제" });
  await user.click(buttons[0]);
  await user.click(buttons[1]);
  await user.click(buttons[2]);
  expect(deleted).toEqual([
    ["label", "l1"],
    ["canned", "c1"],
    ["macro", "m1"],
  ]);
  expect(catalog.textContent).not.toContain("결제");
  expect(catalog.textContent).not.toContain("/인사");
  expect(catalog.textContent).not.toContain("공유");
});

test("administrator creates a shared macro in catalog settings", async () => {
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
        async createMacro(req) {
          created.push(req);
          return { id: "m9", name: req.name };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "카탈로그" }));
  await user.type(screen.getByLabelText("매크로 이름"), "환불 완료");
  await user.type(screen.getByLabelText("공개 메시지"), "환불했습니다");
  await user.click(screen.getByRole("button", { name: "매크로 저장" }));
  expect(created[0].name).toBe("환불 완료");
  expect(created[0].visibility).toBe("account");
  expect(screen.getByRole("region", { name: "카탈로그" }).textContent).toContain("환불 완료");
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

test("failed reply shows a retry control", async () => {
  const user = userEvent.setup();
  const sent = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async sendReply(req) {
          sent.push(req);
          if (sent.length === 1) {
            throw new Error("offline");
          }
          return { message_id: "m9" };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("답장"), "확인했습니다");
  await user.click(screen.getByRole("button", { name: "보내기" }));
  expect(screen.getByRole("log").textContent).toContain("확인했습니다");
  expect(screen.getByRole("button", { name: "재전송" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "재전송" }));
  expect(sent).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "재전송" })).toBeNull();
});

test("pending reply is shown at 70 percent opacity", async () => {
  const user = userEvent.setup();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  render(
    <App
      session={session}
      client={{
        connect() {},
        async sendReply() {
          await gate;
          return { message_id: "m9" };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.type(screen.getByLabelText("답장"), "확인했습니다");
  const pending = user.click(screen.getByRole("button", { name: "보내기" }));
  expect(await screen.findByText(/전송 중/)).toBeTruthy();
  expect(document.querySelector('[data-status="sending"]').className).toMatch(/opacity-70/);
  release();
  await pending;
});

test("desktop layout keeps queue thread and context visible", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={session}
      client={{ connect() {} }}
      initialState={fixtureState()}
      viewportWidth={1440}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  expect(screen.getByRole("navigation", { name: "대기열" })).toBeTruthy();
  expect(screen.getByRole("log")).toBeTruthy();
  expect(screen.getByRole("region", { name: "티켓 라벨" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "대기열로" })).toBeNull();
});

test("thread header folds assign snooze and macros into disclosures", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={session}
      client={{
        connect() {},
        async listMacros() {
          return { macros: [{ id: "m1", name: "환불 완료" }] };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  const header = document.querySelector(".thread-header");
  const assign = header.querySelector("details.assign-menu");
  const snooze = header.querySelector("details.snooze-menu");
  const macros = header.querySelector("details.macros-menu");
  expect(assign).toBeTruthy();
  expect(snooze).toBeTruthy();
  expect(macros).toBeTruthy();
  expect(assign.open).toBe(false);
  expect(snooze.open).toBe(false);
  expect(macros.open).toBe(false);
  expect(screen.getByRole("button", { name: "대기" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "해결" })).toBeTruthy();
  await user.click(screen.getByText("담당자", { selector: "summary" }));
  expect(assign.open).toBe(true);
  expect(screen.getByLabelText("담당자 ID")).toBeTruthy();
  await user.click(screen.getByText("스누즈", { selector: "summary" }));
  expect(assign.open).toBe(false);
  expect(snooze.open).toBe(true);
});

test("laptop width puts context behind a drawer", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={session}
      client={{ connect() {} }}
      initialState={fixtureState()}
      viewportWidth={1100}
    />,
  );
  expect(screen.getByRole("navigation", { name: "대기열" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  expect(screen.getByRole("log")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "고객 정보" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "고객 정보" }));
  expect(screen.getByRole("dialog", { name: "고객 정보" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "티켓 라벨" })).toBeTruthy();
});

test("narrow width switches between queue and thread", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={session}
      client={{ connect() {} }}
      initialState={fixtureState()}
      viewportWidth={800}
    />,
  );
  expect(screen.getByRole("navigation", { name: "대기열" })).toBeTruthy();
  expect(screen.queryByRole("log")).toBeNull();
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  expect(screen.queryByRole("navigation", { name: "대기열" })).toBeNull();
  expect(screen.getByRole("log")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "대기열로" }));
  expect(screen.getByRole("navigation", { name: "대기열" })).toBeTruthy();
  expect(screen.queryByRole("log")).toBeNull();
});

test("queue card shows channel ticket number and sla", () => {
  render(
    <App
      session={session}
      client={{ connect() {} }}
      initialState={{
        ...fixtureState(),
        conversations: [
          {
            ...fixtureState().conversations[0],
            displayId: 1042,
            channel: "web",
            slaBreached: true,
          },
        ],
      }}
    />,
  );
  const card = screen.getByRole("button", { name: /결제 오류/ });
  expect(card.textContent).toContain("Web");
  expect(card.textContent).toContain("#1042");
  expect(card.textContent).toContain("SLA");
});

test("ticket view assigns from the inbox member select", async () => {
  const user = userEvent.setup();
  const assigned = [];
  render(
    <App
      session={{ ...session, userId: "me" }}
      client={{
        connect() {},
        async listInboxMembers() {
          return { members: [{ user_id: "user-1", email: "ada@acme.test", name: "Ada" }] };
        },
        async assignConversation(req) {
          assigned.push(req);
          return { assignee_id: req.assigneeId, status: "open", version: 2 };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await openHeaderMenu(user, "담당자");
  await user.selectOptions(await screen.findByLabelText("담당자"), "user-1");
  expect(screen.getByLabelText("담당자 ID").closest("label").className).toMatch(/field-fallback/);
  expect(assigned[0].assigneeId).toBe("user-1");
});

test("escape closes an open thread header menu", async () => {
  const user = userEvent.setup();
  render(
    <App session={session} client={{ connect() {} }} initialState={fixtureState()} />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await openHeaderMenu(user, "담당자");
  expect(document.querySelector("details.assign-menu")?.open).toBe(true);
  await user.keyboard("{Escape}");
  expect(document.querySelector("details.assign-menu")?.open).toBe(false);
});

test("snooze preset submits immediately", async () => {
  const user = userEvent.setup();
  const snoozed = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async snoozeConversation(req) {
          snoozed.push(req);
          return { status: "snoozed", version: 2, snoozed_until: req.snoozedUntil };
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await openHeaderMenu(user, "스누즈");
  await user.click(screen.getByRole("button", { name: "1시간 뒤" }));
  expect(snoozed).toHaveLength(1);
  expect(Date.parse(snoozed[0].snoozedUntil)).toBeGreaterThan(Date.now());
  expect(screen.queryByRole("button", { name: /결제 오류/ })).toBeNull();
});

test("ticket view snooze input is datetime-local", async () => {
  const user = userEvent.setup();
  render(
    <App session={session} client={{ connect() {} }} initialState={fixtureState()} />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await openHeaderMenu(user, "스누즈");
  expect(screen.getByLabelText("스누즈 시각").getAttribute("type")).toBe("datetime-local");
  expect(screen.getByRole("button", { name: "1시간 뒤" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "오늘 오후 6시" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "내일 09:00" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "다음 주 월요일" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "오늘 오후 6시" }));
  expect(screen.getByLabelText("스누즈 시각").value).toMatch(/T18:00$/);
});

test("keyboard j k r n and e drive the workspace", async () => {
  const user = userEvent.setup();
  const resolved = [];
  const state = fixtureState();
  state.conversations = [
    state.conversations[0],
    {
      id: "c2",
      inboxId: "i1",
      contactId: "p2",
      contactInboxId: "ci2",
      lastContent: "배송 문의",
      unread: 0,
      version: 1,
    },
  ];
  state.messages.c2 = [{ id: "m2", content: "배송 문의", senderType: "Contact" }];
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
      initialState={state}
    />,
  );
  await user.keyboard("j");
  expect(screen.getByRole("log").textContent).toContain("결제 오류");
  await user.keyboard("j");
  expect(screen.getByRole("log").textContent).toContain("배송 문의");
  await user.keyboard("k");
  expect(screen.getByRole("log").textContent).toContain("결제 오류");
  await user.keyboard("r");
  expect(screen.getByLabelText("답장")).toBe(document.activeElement);
  document.activeElement.blur();
  await user.keyboard("n");
  expect(await screen.findByLabelText("메모")).toBe(document.activeElement);
  document.activeElement.blur();
  await user.keyboard("e");
  expect(resolved[0].conversationId).toBe("c1");
});

test("mod k opens the macro menu", async () => {
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
          return {};
        },
      }}
      initialState={fixtureState()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  await user.keyboard("{Meta>}k{/Meta}");
  expect(document.querySelector("details.macros-menu")?.open).toBe(true);
  expect(await screen.findByRole("button", { name: "실행" })).toBe(document.activeElement);
  await user.keyboard("{Enter}");
  expect(ran[0].macroId).toBe("m1");
});

test("mod enter submits the composer", async () => {
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
  await user.keyboard("{Meta>}{Enter}{/Meta}");
  expect(sent[0].content).toBe("확인했습니다");
});

test("presence event updates rail availability without online fallback", async () => {
  let emit;
  render(
    <App
      session={{ ...session, userId: "u1", name: "Ada" }}
      client={{
        connect(_s, onEvent) {
          emit = onEvent;
          return () => {};
        },
      }}
    />,
  );
  expect(screen.getByLabelText("가용 상태").getAttribute("data-availability")).not.toBe("online");
  await act(async () => {
    emit({ type: "event", event: "presence", user_id: "u1", status: "online" });
  });
  expect(screen.getByLabelText("가용 상태").getAttribute("data-availability")).toBe("online");
});

test("shows typing indicator for the other party", async () => {
  let emit;
  render(
    <App
      session={{ ...session, userId: "agent-1" }}
      client={{
        connect(_s, onEvent) {
          emit = onEvent;
          return () => {};
        },
      }}
      initialState={{ ...fixtureState(), selectedId: "c1" }}
    />,
  );
  await act(async () => {
    emit({
      type: "event",
      event: "typing",
      conversation_id: "c1",
      user_id: "p1",
      user_type: "Contact",
      is_typing: true,
    });
  });
  expect(screen.getByText("입력 중")).toBeTruthy();
});

test("rail shows unread availability shortcuts and signs out", async () => {
  const user = userEvent.setup();
  const left = [];
  render(
    <App
      session={{ ...session, availabilityStatus: "online", name: "Ada", email: "ada@acme.test" }}
      client={{
        connect() {},
        async signOut(req) {
          left.push(req);
        },
      }}
      initialState={fixtureState()}
    />,
  );
  const avatar = screen.getByLabelText("가용 상태");
  expect(avatar.getAttribute("data-availability")).toBe("online");
  expect(avatar.textContent).toMatch(/A/);
  expect(screen.getByRole("button", { name: "대기열" }).textContent).toContain("1");
  await user.click(screen.getByRole("button", { name: "단축키" }));
  expect(screen.getByRole("dialog", { name: "단축키" }).textContent).toMatch(/J|K|R|N|E/);
  await user.click(screen.getByRole("button", { name: "로그아웃" }));
  expect(left).toHaveLength(1);
  expect(screen.getByRole("form", { name: "로그인" })).toBeTruthy();
});

test("queue card shows contact name relative time and sla tint", () => {
  render(
    <App
      session={session}
      client={{ connect() {} }}
      initialState={{
        ...fixtureState(),
        conversations: [
          {
            ...fixtureState().conversations[0],
            displayId: 1042,
            channel: "web",
            contactName: "홍길동",
            lastActivityAt: new Date(Date.now() - 2 * 60_000).toISOString(),
            slaBreached: true,
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole("heading", { name: /대기열/ }).textContent).toMatch(/1/);
  const card = screen.getByRole("button", { name: /결제 오류/ });
  expect(card.textContent).toContain("홍길동");
  expect(card.textContent).toMatch(/분 전|방금/);
  expect(card.className).toMatch(/queue-card-sla/);
});

test("thread header uses ticket number and timeline stamps", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={session}
      client={{ connect() {} }}
      initialState={{
        conversations: [
          {
            ...fixtureState().conversations[0],
            displayId: 1042,
            status: "open",
            channel: "email",
            contactName: "홍길동",
            contactEmail: "ada@acme.test",
            appliedSlas: { frtDueAt: new Date(Date.now() + 18 * 60_000).toISOString() },
          },
        ],
        selectedId: null,
        messages: {
          c1: [
            {
              id: "m1",
              content: "결제 오류",
              senderType: "Contact",
              createdAt: "2026-10-30T05:20:00.000Z",
            },
            {
              id: "m2",
              content: "확인했습니다",
              senderType: "User",
              createdAt: "2026-10-30T05:22:00.000Z",
            },
            {
              id: "m3",
              content: "환불 검토",
              senderType: "User",
              private: true,
            },
          ],
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  expect(document.querySelector(".thread-header").textContent).toContain("#1042");
  expect(document.querySelector(".thread-header").textContent).toContain("홍길동");
  expect(document.querySelector(".thread-header").textContent).not.toContain("결제 오류");
  expect(document.querySelector(".thread-header").textContent).toContain("Email");
  expect(screen.getByRole("log").textContent).toContain("결제 오류");
  expect(screen.getByRole("log").textContent).toMatch(/전송됨/);
  expect(screen.getByRole("log").textContent).toMatch(/내부 메모 \(상담원에게만 보임\)/);
  expect(screen.getByRole("region", { name: "고객 프로필" }).textContent).toMatch(/홍길동/);
  expect(screen.getByRole("region", { name: "채널 상태" }).textContent).toMatch(/#REQ-1042|FRT/);
});

test("thread header uses slate for snoozed and emerald for open", () => {
  render(
    <App
      session={session}
      client={{ connect() {} }}
      initialState={{
        ...fixtureState(),
        selectedId: "c1",
        conversations: [
          {
            ...fixtureState().conversations[0],
            status: "snoozed",
            snoozedUntil: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
      }}
    />,
  );
  expect(document.querySelector(".thread-header [data-slot='badge']").className).toMatch(/slate/);
});

test("note composer uses amber send and kakao session warning", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={session}
      client={{ connect() {} }}
      initialState={{
        ...fixtureState(),
        conversations: [
          {
            ...fixtureState().conversations[0],
            channel: "kakao",
          },
        ],
        messages: {
          c1: [
            {
              id: "m1",
              content: "결제 오류",
              senderType: "Contact",
              createdAt: new Date(Date.now() - 28 * 86400_000).toISOString(),
            },
          ],
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
  expect(screen.getByRole("region", { name: "채널 상태" }).textContent).toMatch(/세션/);
  await user.click(screen.getByRole("button", { name: "내부 메모" }));
  expect(screen.getByRole("button", { name: "메모" }).className).toMatch(/amber/);
  expect(document.querySelector("form.note label")).toBeNull();
  expect(document.querySelector("form.note [data-slot='textarea']")).toBeTruthy();
});

test("administrator sees CSAT percent and SLA hit rate", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async getReport() {
          return { csat_percent: 80, sla_hit_rate: 75, conversations: { total: 10, resolved: 4 } };
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "리포트" }));
  expect(screen.getByRole("region", { name: "리포트" }).textContent).toContain("80");
  expect(screen.getByRole("region", { name: "리포트" }).textContent).toContain("75");
});

test("administrator registers a webhook", async () => {
  const user = userEvent.setup();
  const created = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listWebhooks() {
          return { webhooks: [] };
        },
        async createWebhook(req) {
          created.push(req);
          return { id: "wh1", url: req.url };
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "웹훅" }));
  await user.type(screen.getByLabelText("웹훅 URL"), "https://crm.example/hook");
  await user.click(screen.getByRole("button", { name: "웹훅 추가" }));
  expect(created[0].url).toBe("https://crm.example/hook");
  expect(screen.getByRole("region", { name: "웹훅" }).textContent).toContain("https://crm.example/hook");
});

test("administrator registers an ops MCP server", async () => {
  const user = userEvent.setup();
  const created = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listMCP() {
          return { mcp_servers: [] };
        },
        async upsertMCP(req) {
          created.push(req);
          return { id: "m1", name: req.name, url: req.url };
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "MCP" }));
  await user.type(screen.getByLabelText("MCP 이름"), "shop");
  await user.type(screen.getByLabelText("MCP URL"), "https://ops.example/mcp");
  await user.click(screen.getByRole("button", { name: "MCP 추가" }));
  expect(created[0].url).toBe("https://ops.example/mcp");
  expect(screen.getByRole("region", { name: "MCP" }).textContent).toContain("https://ops.example/mcp");
});

test("administrator rotates mcp auth header", async () => {
  const user = userEvent.setup();
  const rotated = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listMCP() {
          return {
            mcp_servers: [{ id: "m1", name: "shop", url: "https://ops.example/mcp", auth_header: "Bearer old" }],
          };
        },
        async rotateMCP(req) {
          rotated.push(req);
          return { id: "m1", name: "shop", url: "https://ops.example/mcp", auth_header: req.auth_header };
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "MCP" }));
  expect((await screen.findByRole("region", { name: "MCP" })).textContent).toContain("••••••••");
  await user.type(screen.getByLabelText("인증 헤더"), "Bearer new");
  await user.click(screen.getByRole("button", { name: "재발급" }));
  expect(rotated[0].mcp_server_id).toBe("m1");
  expect(rotated[0].auth_header).toBe("Bearer new");
});

test("administrator overrides an agent skill", async () => {
  const user = userEvent.setup();
  const created = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listSkills() {
          return { agent_skills: [] };
        },
        async upsertSkill(req) {
          created.push(req);
          return { id: "s1", name: req.name, body: req.body };
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "Agent Skills" }));
  await user.type(screen.getByLabelText("스킬 이름"), "refund-policy");
  await user.type(screen.getByLabelText("스킬 본문"), "TENANT_BODY");
  await user.click(screen.getByRole("button", { name: "스킬 저장" }));
  expect(created[0].name).toBe("refund-policy");
  expect(screen.getByRole("region", { name: "Agent Skills" }).textContent).toContain("refund-policy");
});

test("administrator publishes a help article", async () => {
  const user = userEvent.setup();
  const created = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listArticles() {
          return { articles: [] };
        },
        async createArticle(req) {
          created.push(req);
          return { id: "a1", title: req.title, slug: req.slug };
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "도움말" }));
  await user.type(screen.getByLabelText("문서 제목"), "결제 오류");
  await user.type(screen.getByLabelText("slug"), "pay-error");
  await user.type(screen.getByLabelText("본문"), "한도를 확인하세요");
  await user.click(screen.getByRole("button", { name: "문서 게시" }));
  expect(created[0].title).toBe("결제 오류");
  expect(created[0].published).toBe(true);
  expect(screen.getByRole("region", { name: "도움말" }).textContent).toContain("결제 오류");
});

test("administrator deletes a help article", async () => {
  const user = userEvent.setup();
  const deleted = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listArticles() {
          return { articles: [{ id: "a1", title: "결제 오류", slug: "pay-error" }] };
        },
        async deleteArticle(req) {
          deleted.push(req);
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "도움말" }));
  expect(await screen.findByText("결제 오류")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "삭제" }));
  expect(deleted[0].article_id).toBe("a1");
  expect(screen.getByRole("region", { name: "도움말" }).textContent).not.toContain("결제 오류");
});

test("administrator settings nav groups inbox content integration and reports", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{ connect() {} }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  expect(screen.getByRole("heading", { name: "인박스" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "콘텐츠" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "연동" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "분석" })).toBeTruthy();
});

test("administrator deletes a webhook", async () => {
  const user = userEvent.setup();
  const deleted = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listWebhooks() {
          return { webhooks: [{ id: "wh1", url: "https://crm.example/hook" }] };
        },
        async deleteWebhook(req) {
          deleted.push(req);
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "웹훅" }));
  expect(await screen.findByText("https://crm.example/hook")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "삭제" }));
  expect(deleted[0].webhook_id).toBe("wh1");
  expect(screen.getByRole("region", { name: "웹훅" }).textContent).not.toContain("https://crm.example/hook");
});

test("administrator deletes an ops MCP server", async () => {
  const user = userEvent.setup();
  const deleted = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listMCP() {
          return {
            mcp_servers: [{ id: "m1", name: "shop", url: "https://ops.example/mcp", auth_header: "Bearer old" }],
          };
        },
        async deleteMCP(req) {
          deleted.push(req);
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "MCP" }));
  expect((await screen.findByRole("region", { name: "MCP" })).textContent).toContain("https://ops.example/mcp");
  await user.click(screen.getByRole("button", { name: "삭제" }));
  expect(deleted[0].mcp_server_id).toBe("m1");
  expect(screen.getByRole("region", { name: "MCP" }).textContent).not.toContain("https://ops.example/mcp");
});

test("administrator deletes an agent skill", async () => {
  const user = userEvent.setup();
  const deleted = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listSkills() {
          return { agent_skills: [{ id: "s1", name: "refund-policy", description: "환불", body: "TENANT_BODY" }] };
        },
        async deleteSkill(req) {
          deleted.push(req);
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "Agent Skills" }));
  expect(await screen.findByText("refund-policy")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "삭제" }));
  expect(deleted[0].skill_id).toBe("s1");
  expect(screen.getByRole("region", { name: "Agent Skills" }).textContent).not.toContain("refund-policy");
});

test("administrator edits an agent skill from the list", async () => {
  const user = userEvent.setup();
  const saved = [];
  render(
    <App
      session={{ ...session, role: "administrator" }}
      client={{
        connect() {},
        async listSkills() {
          return { agent_skills: [{ id: "s1", name: "refund-policy", description: "환불", body: "OLD" }] };
        },
        async upsertSkill(req) {
          saved.push(req);
          return { id: "s1", name: req.name, description: req.description, body: req.body };
        },
      }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "설정" }));
  await user.click(screen.getByRole("button", { name: "Agent Skills" }));
  await user.click(await screen.findByRole("button", { name: "refund-policy" }));
  expect(screen.getByLabelText("스킬 본문").value).toBe("OLD");
  await user.clear(screen.getByLabelText("스킬 본문"));
  await user.type(screen.getByLabelText("스킬 본문"), "NEW");
  await user.click(screen.getByRole("button", { name: "스킬 저장" }));
  expect(saved[0].name).toBe("refund-policy");
  expect(saved[0].body).toBe("NEW");
});

test("context panel shows living profile chips without changing layout", async () => {
  const user = userEvent.setup();
  render(
    <App
      session={session}
      client={{
        connect() {},
        async listEgo() {
          return {
            nodes: [
              { id: "n1", entity_type: "PainPoint", name: "결제 오류", hop: 1 },
              { id: "n2", entity_type: "Product", name: "프로 플랜", hop: 1 },
            ],
          };
        },
      }}
      initialState={{ ...fixtureState(), selectedId: "c1" }}
    />,
  );
  expect(await screen.findByRole("region", { name: "Living Profile" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Living Profile" }).textContent).toMatch(/결제 오류/);
  expect(screen.getByRole("region", { name: "Living Profile" }).textContent).toMatch(/프로 플랜/);
  expect(document.querySelector(".rail")).toBeTruthy();
  expect(document.querySelector(".context-pane")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /결제 오류/ }));
});

test("thread renders tool approval card", async () => {
  const approved = [];
  render(
    <App
      session={session}
      client={{
        connect() {},
        async approveTool(req) {
          approved.push(req.executionId);
          return { ok: true };
        },
      }}
      initialState={{
        ...fixtureState(),
        selectedId: "c1",
        messages: {
          c1: [
            {
              id: "m-ai",
              content: JSON.stringify({
                kind: "tool_approval",
                execution_id: "ex1",
                tool_name: "refund",
                summary: "결제 취소 실행",
              }),
              senderType: "AgentBot",
              contentType: "form",
            },
          ],
        },
      }}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "승인 및 실행" }));
  expect(approved).toEqual(["ex1"]);
  expect(screen.getByRole("group", { name: "AI 승인 요청" }).textContent).toMatch(/결제 취소/);
});
