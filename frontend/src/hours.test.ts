import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { defaultHours, parseBusinessHours, serializeBusinessHours } from "./hours.js";

describe("parseBusinessHours", () => {
  it("defaults empty json to weekday 09:00-18:00 in Seoul", () => {
    const got = parseBusinessHours({});
    assert.equal(got.timezone, "Asia/Seoul");
    assert.equal(got.week.mon.open, true);
    assert.equal(got.week.mon.start, "09:00");
    assert.equal(got.week.sat.open, false);
  });

  it("reads the first slot per weekday and treats empty arrays as closed", () => {
    const got = parseBusinessHours({
      timezone: "UTC",
      week: { mon: [["10:00", "19:00"]], sat: [] },
    });
    assert.equal(got.timezone, "UTC");
    assert.deepEqual(got.week.mon, { open: true, start: "10:00", end: "19:00" });
    assert.equal(got.week.sat.open, false);
    assert.equal(got.week.tue.open, false);
  });
});

describe("serializeBusinessHours", () => {
  it("emits week slots the routing contract expects", () => {
    const form = defaultHours();
    form.week.mon = { open: true, start: "10:00", end: "19:00" };
    form.week.sat = { open: false, start: "09:00", end: "18:00" };
    assert.deepEqual(serializeBusinessHours(form), {
      timezone: "Asia/Seoul",
      week: {
        mon: [["10:00", "19:00"]],
        tue: [["09:00", "18:00"]],
        wed: [["09:00", "18:00"]],
        thu: [["09:00", "18:00"]],
        fri: [["09:00", "18:00"]],
        sat: [],
        sun: [],
      },
    });
  });
});
