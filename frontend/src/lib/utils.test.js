import { expect, test } from "vitest";
import { cn } from "./utils.js";

test("cn merges conflicting tailwind classes", () => {
  expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
});
