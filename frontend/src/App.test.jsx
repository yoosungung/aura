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
  await user.type(screen.getByRole("textbox"), "확인했습니다");
  await user.click(screen.getByRole("button", { name: "보내기" }));
  expect(sent[0].content).toBe("확인했습니다");
  expect(sent[0].conversation.id).toBe("c1");
});
