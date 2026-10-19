import { describe, expect, it } from "vitest";
import type { Schedule } from "../src/shared/automations";
import { describeSchedule, dueTimes, nextDue, runKey, validSchedule, zonedParts, zonedToUtc } from "../src/main/automations/schedule";

const BANGKOK = "Asia/Bangkok";
const NY = "America/New_York";
const LONDON = "Europe/London";

describe("validSchedule", () => {
  it("accepts well-formed schedules", () => {
    expect(validSchedule({ kind: "interval", everyMinutes: 1 })).toBeNull();
    expect(validSchedule({ kind: "interval", everyMinutes: 10080 })).toBeNull();
    expect(validSchedule({ kind: "daily", at: "00:00", timeZone: BANGKOK })).toBeNull();
    expect(validSchedule({ kind: "daily", at: "23:59", days: [0, 6], timeZone: LONDON })).toBeNull();
    expect(validSchedule({ kind: "daily", at: "09:00", days: [1, 3, 5], timeZone: LONDON })).toBeNull();
  });

  it("names the problem with everyMinutes", () => {
    for (const everyMinutes of [0, 10081, 1.5, Number.NaN]) {
      expect(validSchedule({ kind: "interval", everyMinutes })).toBe("everyMinutes must be an integer between 1 and 10080");
    }
  });

  it("names the problem with at", () => {
    for (const at of ["9:00", "24:00", "09:60", "0900", "09:00:00"]) {
      expect(validSchedule({ kind: "daily", at, timeZone: BANGKOK })).toBe("at must be HH:MM (24-hour)");
    }
  });

  it("names the problem with days", () => {
    expect(validSchedule({ kind: "daily", at: "09:00", days: [], timeZone: BANGKOK })).toBe("days must not be empty");
    expect(validSchedule({ kind: "daily", at: "09:00", days: [1, 3, 3], timeZone: BANGKOK })).toBe("days must not repeat");
    for (const days of [[7], [-1], [1.5]]) {
      expect(validSchedule({ kind: "daily", at: "09:00", days, timeZone: BANGKOK })).toBe("days must be weekdays 0..6");
    }
  });

  it("names the problem with timeZone", () => {
    for (const timeZone of ["Not/AZone", "Mars/Phobos"]) {
      expect(validSchedule({ kind: "daily", at: "09:00", timeZone })).toBe("timeZone must be a valid IANA zone");
    }
  });
});

describe("zonedParts", () => {
  it("reads the wall clock and weekday", () => {
    expect(zonedParts(Date.UTC(2026, 2, 8, 7, 0), NY)).toEqual({ year: 2026, month: 3, day: 8, hour: 3, minute: 0, weekday: 0 });
  });
});

describe("zonedToUtc", () => {
  it("resolves a spring-forward gap to the first valid minute after it", () => {
    expect(zonedToUtc(2026, 3, 8, 2, 30, NY)).toBe(Date.UTC(2026, 2, 8, 7, 0));
  });

  it("resolves a fall-back ambiguity to the first occurrence", () => {
    expect(zonedToUtc(2026, 11, 1, 1, 30, NY)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });
});

describe("nextDue", () => {
  it("steps an interval by its anchor", () => {
    const s: Schedule = { kind: "interval", everyMinutes: 30 };
    const anchor = Date.UTC(2026, 0, 5, 0, 0);
    expect(nextDue(s, Date.UTC(2026, 0, 5, 0, 10), anchor)).toBe(Date.UTC(2026, 0, 5, 0, 30));
    expect(nextDue(s, Date.UTC(2026, 0, 5, 0, 30), anchor)).toBe(Date.UTC(2026, 0, 5, 1, 0));
    expect(nextDue(s, 0)).toBe(30 * 60_000);
  });

  it("finds the next 09:00 in a zone with no DST", () => {
    const s: Schedule = { kind: "daily", at: "09:00", timeZone: BANGKOK };
    expect(nextDue(s, Date.UTC(2026, 0, 5, 1, 0))).toBe(Date.UTC(2026, 0, 5, 2, 0));
    expect(nextDue(s, Date.UTC(2026, 0, 5, 2, 0))).toBe(Date.UTC(2026, 0, 6, 2, 0));
  });

  it("skips days outside the days filter across a weekend", () => {
    const s: Schedule = { kind: "daily", at: "09:00", days: [1, 3, 5], timeZone: BANGKOK };
    // Friday 10:00 Bangkok -> the following Monday 09:00, past the weekend.
    expect(nextDue(s, Date.UTC(2026, 0, 2, 3, 0))).toBe(Date.UTC(2026, 0, 5, 2, 0));
  });

  it("runs a gapped 02:30 job at 03:00 local on US spring-forward day", () => {
    const s: Schedule = { kind: "daily", at: "02:30", timeZone: NY };
    const gap = nextDue(s, Date.UTC(2026, 2, 8, 0, 0));
    expect(gap).toBe(Date.UTC(2026, 2, 8, 7, 0));
    expect(zonedParts(gap, NY)).toMatchObject({ hour: 3, minute: 0 });
    // The next day it is back to a real 02:30, now on daylight time.
    expect(nextDue(s, gap)).toBe(Date.UTC(2026, 2, 9, 6, 30));
  });

  it("runs a fall-back 01:30 job once, at the first 01:30", () => {
    const s: Schedule = { kind: "daily", at: "01:30", timeZone: NY };
    const first = nextDue(s, Date.UTC(2026, 10, 1, 0, 0));
    expect(first).toBe(Date.UTC(2026, 10, 1, 5, 30));
    const next = nextDue(s, first);
    expect(next).toBe(Date.UTC(2026, 10, 2, 6, 30));
    expect(next).not.toBe(Date.UTC(2026, 10, 1, 6, 30));
  });

  it("shifts the UTC hour across the London DST change", () => {
    const s: Schedule = { kind: "daily", at: "09:00", timeZone: LONDON };
    const before = nextDue(s, Date.UTC(2026, 2, 28, 0, 0));
    expect(before).toBe(Date.UTC(2026, 2, 28, 9, 0));
    const after = nextDue(s, before);
    expect(after).toBe(Date.UTC(2026, 2, 29, 8, 0));
    expect(new Date(before).getUTCHours()).toBe(9);
    expect(new Date(after).getUTCHours()).toBe(8);
  });
});

describe("dueTimes", () => {
  it("coalesces missed runs into the latest instant", () => {
    const s: Schedule = { kind: "daily", at: "09:00", timeZone: BANGKOK };
    const last = Date.UTC(2026, 0, 5, 2, 0); // Mon 09:00 Bangkok
    const now = Date.UTC(2026, 0, 8, 3, 0); // Thu 10:00 Bangkok, three days later
    expect(dueTimes(s, last, now, "coalesce")).toEqual([Date.UTC(2026, 0, 8, 2, 0)]);
  });

  it("drops a run missed by more than 60 seconds under skip", () => {
    const s: Schedule = { kind: "daily", at: "09:00", timeZone: BANGKOK };
    const last = Date.UTC(2026, 0, 5, 2, 0);
    const now = Date.UTC(2026, 0, 8, 3, 0);
    expect(dueTimes(s, last, now, "skip")).toEqual([]);
  });

  it("keeps a run under skip when now is within 60 seconds of it", () => {
    const s: Schedule = { kind: "daily", at: "09:00", timeZone: BANGKOK };
    const last = Date.UTC(2026, 0, 7, 2, 0);
    const now = Date.UTC(2026, 0, 8, 2, 0, 30); // 30 s after the 09:00 Bangkok run
    expect(dueTimes(s, last, now, "skip")).toEqual([Date.UTC(2026, 0, 8, 2, 0)]);
  });

  it("returns nothing for a brand-new automation", () => {
    const s: Schedule = { kind: "interval", everyMinutes: 30 };
    expect(dueTimes(s, null, Date.UTC(2026, 0, 5, 1, 0), "coalesce")).toEqual([]);
    expect(dueTimes(s, null, Date.UTC(2026, 0, 5, 1, 0), "skip")).toEqual([]);
  });

  it("folds missed intervals with an anchor", () => {
    const s: Schedule = { kind: "interval", everyMinutes: 30 };
    const anchor = Date.UTC(2026, 0, 5, 0, 0);
    const now = Date.UTC(2026, 0, 5, 1, 35);
    expect(dueTimes(s, anchor, now, "coalesce", anchor)).toEqual([Date.UTC(2026, 0, 5, 1, 30)]);
    expect(dueTimes(s, anchor, now, "skip", anchor)).toEqual([]);
  });
});

describe("runKey", () => {
  it("is stable per instant and differs per instant and automation", () => {
    const ms = Date.UTC(2026, 0, 5, 2, 0);
    expect(runKey("auto-1", ms)).toBe(runKey("auto-1", ms));
    expect(runKey("auto-1", ms)).toBe(`auto-1@${new Date(ms).toISOString()}`);
    expect(runKey("auto-1", ms)).not.toBe(runKey("auto-1", ms + 60_000));
    expect(runKey("auto-1", ms)).not.toBe(runKey("auto-2", ms));
  });
});

describe("describeSchedule", () => {
  it("phrases intervals", () => {
    expect(describeSchedule({ kind: "interval", everyMinutes: 30 })).toBe("every 30 min");
    expect(describeSchedule({ kind: "interval", everyMinutes: 120 })).toBe("every 2 h");
    expect(describeSchedule({ kind: "interval", everyMinutes: 90 })).toBe("every 90 min");
  });

  it("phrases daily schedules with and without days", () => {
    expect(describeSchedule({ kind: "daily", at: "09:00", timeZone: BANGKOK })).toBe("daily at 09:00 (Asia/Bangkok)");
    expect(describeSchedule({ kind: "daily", at: "09:00", days: [1, 3, 5], timeZone: LONDON })).toBe("Mon, Wed, Fri at 09:00 (Europe/London)");
  });
});
