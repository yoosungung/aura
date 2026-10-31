import { expect, test } from "vitest";
import { cn, slugFromTitle } from "./utils.js";

test("cn merges conflicting tailwind classes", () => {
  expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
});

test("slugFromTitle hyphenates unicode titles", () => {
  expect(slugFromTitle("결제 오류")).toBe("결제-오류");
  expect(slugFromTitle("Pay Error")).toBe("pay-error");
  expect(slugFromTitle("  결제  오류!! ")).toBe("결제-오류");
  expect(slugFromTitle("결제 FAQ")).toBe("결제-faq");
  expect(slugFromTitle("!!!")).toBe("");
});
