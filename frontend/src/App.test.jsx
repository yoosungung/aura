import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { App } from "./App.jsx";
import { fixtureState } from "./store.js";

afterEach(() => cleanup());

const session = { accountId: "acc", token: "tok", gatewayUrl: "" };

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
