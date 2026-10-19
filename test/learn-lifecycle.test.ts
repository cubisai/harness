import { describe, expect, it } from "vitest";
import type { Lesson, LessonVerification } from "../src/shared/learn";
import { MAX_INJECTED, applyAction, autoRetire, countOutcome, lessonsBlock, promotion, relevantLessons, revalidation } from "../src/main/learn/lifecycle";

function lesson(over: Partial<Lesson> = {}): Lesson {
  return {
    id: "l1",
    projectId: "p1",
    rule: "Run the unit tests before claiming a fix",
    why: "the check failed",
    scope: { paths: [], keywords: [] },
    status: "active",
    helpful: 0,
    harmful: 0,
    relevant: 0,
    tries: 0,
    pinned: false,
    caseId: null,
    provenance: { threadId: "t1", userSeq: 1, signals: [], agent: "opencode", model: "m1" },
    verified: null,
    note: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function verification(over: Partial<LessonVerification> = {}): LessonVerification {
  return { model: "m1", agent: "opencode", appVersion: "1.2.3", at: 0, before: { passed: 0, of: 1 }, after: { passed: 1, of: 1 }, transfer: { held: 1, of: 1 }, ...over };
}

describe("relevantLessons", () => {
  it("keeps active lessons, pinned first, then net help, then newest", () => {
    const a = lesson({ id: "a", helpful: 1, harmful: 0, updatedAt: 5 });
    const b = lesson({ id: "b", helpful: 5, harmful: 0, updatedAt: 1 });
    const pinned = lesson({ id: "p", pinned: true, helpful: 0, harmful: 9, updatedAt: 0 });
    const old = lesson({ id: "old", helpful: 0, harmful: 0, updatedAt: 9 });
    expect(relevantLessons([a, b, pinned, old]).map((l) => l.id)).toEqual(["p", "b", "a", "old"]);
  });

  it("defaults to MAX_INJECTED and slices to an explicit max", () => {
    const many = Array.from({ length: 8 }, (_, i) => lesson({ id: `l${i}`, updatedAt: 8 - i }));
    expect(MAX_INJECTED).toBe(5);
    expect(relevantLessons(many)).toHaveLength(MAX_INJECTED);
    expect(relevantLessons(many, 2).map((l) => l.id)).toEqual(["l0", "l1"]);
  });

  it("excludes non-active lessons and doesn't mutate the input", () => {
    const input = [lesson({ id: "a" }), lesson({ id: "r", status: "retired" }), lesson({ id: "c", status: "candidate" }), lesson({ id: "d", status: "dropped" })];
    const order = input.map((l) => l.id);
    expect(relevantLessons(input).map((l) => l.id)).toEqual(["a"]);
    expect(input.map((l) => l.id)).toEqual(order);
  });
});

describe("lessonsBlock", () => {
  it("is null for no lessons", () => {
    expect(lessonsBlock([])).toBeNull();
  });

  it("wraps one - line per lesson, with (why) only when set", () => {
    const block = lessonsBlock([lesson({ rule: "Use tabs", why: "the linter" }), lesson({ rule: "Keep commits short", why: "" })]);
    expect(block).toBe(
      "<harness-lessons>\nRules learned from earlier turns in this project. Follow them unless the user says otherwise.\n- Use tabs (the linter)\n- Keep commits short\n</harness-lessons>",
    );
  });

  it("flattens newlines in rule and why and clips the line to 300 chars", () => {
    expect(lessonsBlock([lesson({ rule: "line one\nline two", why: "why\nhere" })])).toContain("- line one line two (why here)");
    const line = lessonsBlock([lesson({ rule: "x".repeat(400), why: "" })])!.split("\n")[2]!;
    expect(line.length).toBe(300);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("countOutcome", () => {
  it("counts every sent turn relevant, and ok/fail help/harm", () => {
    const l = lesson({ relevant: 2, helpful: 1, harmful: 0 });
    expect(countOutcome(l, "ok")).toEqual({ relevant: 3, helpful: 2, harmful: 0 });
    expect(countOutcome(l, "fail")).toEqual({ relevant: 3, helpful: 1, harmful: 1 });
    expect(countOutcome(l, "warn")).toEqual({ relevant: 3, helpful: 1, harmful: 0 });
  });
});

describe("autoRetire", () => {
  it("retires an active lesson that hurts 3+ and more than twice its help", () => {
    expect(autoRetire({ status: "active", helpful: 1, harmful: 3, relevant: 6 })).toEqual({ status: "retired", note: "retired: hurt 3 of 6 turns" });
    expect(autoRetire({ status: "active", helpful: 0, harmful: 3, relevant: 3 })).toEqual({ status: "retired", note: "retired: hurt 3 of 3 turns" });
  });

  it("doesn't retire at the edge or when help outweighs the harm", () => {
    expect(autoRetire({ status: "active", helpful: 0, harmful: 2, relevant: 4 })).toBeNull();
    expect(autoRetire({ status: "active", helpful: 2, harmful: 3, relevant: 5 })).toBeNull();
  });

  it("never retires a non-active lesson", () => {
    expect(autoRetire({ status: "candidate", helpful: 0, harmful: 9, relevant: 9 })).toBeNull();
    expect(autoRetire({ status: "retired", helpful: 0, harmful: 9, relevant: 9 })).toBeNull();
  });
});

describe("applyAction", () => {
  it("retires only active or candidate lessons", () => {
    expect(applyAction(lesson({ status: "active" }), "retire")).toEqual({ status: "retired", note: "retired by you" });
    expect(applyAction(lesson({ status: "candidate" }), "retire")).toEqual({ status: "retired", note: "retired by you" });
    expect(applyAction(lesson({ status: "retired" }), "retire")).toBeNull();
    expect(applyAction(lesson({ status: "dropped" }), "retire")).toBeNull();
  });

  it("undoes a retired or dropped lesson only to active when verified", () => {
    expect(applyAction(lesson({ status: "retired", verified: verification() }), "undo")).toEqual({ status: "active", note: null });
    expect(applyAction(lesson({ status: "dropped", verified: null }), "undo")).toEqual({ status: "candidate", note: null });
    expect(applyAction(lesson({ status: "active", verified: verification() }), "undo")).toBeNull();
    expect(applyAction(lesson({ status: "candidate" }), "undo")).toBeNull();
  });

  it("pins any status but dropped, unpins anything", () => {
    expect(applyAction(lesson({ status: "candidate" }), "pin")).toEqual({ pinned: true });
    expect(applyAction(lesson({ status: "retired" }), "pin")).toEqual({ pinned: true });
    expect(applyAction(lesson({ status: "dropped" }), "pin")).toBeNull();
    expect(applyAction(lesson({ status: "active", pinned: true }), "unpin")).toEqual({ pinned: false });
    expect(applyAction(lesson({ status: "dropped", pinned: true }), "unpin")).toEqual({ pinned: false });
  });

  it("drops only a candidate", () => {
    expect(applyAction(lesson({ status: "candidate" }), "drop")).toEqual({ status: "dropped", note: "dropped by you" });
    expect(applyAction(lesson({ status: "active" }), "drop")).toBeNull();
    expect(applyAction(lesson({ status: "retired" }), "drop")).toBeNull();
  });
});

describe("revalidation", () => {
  const rt = { model: "m1", agent: "opencode", appVersion: "1.2.3" };

  it("stays null only for a matching active, verified lesson", () => {
    expect(revalidation(lesson({ verified: verification() }), rt)).toBeNull();
  });

  it("asks for verification when never verified", () => {
    expect(revalidation(lesson({ verified: null }), rt)).toBe("never verified");
  });

  it("flags a different model or agent", () => {
    expect(revalidation(lesson({ verified: verification({ model: "old" }) }), rt)).toBe("verified on old, now m1");
    expect(revalidation(lesson({ verified: verification({ agent: "codex" }) }), rt)).toBe("verified on codex, now opencode");
  });

  it("flags a major or minor app change but not a patch", () => {
    expect(revalidation(lesson({ verified: verification({ appVersion: "2.0.0" }) }), rt)).toBe("verified on app 2.0.0, now 1.2.3");
    expect(revalidation(lesson({ verified: verification({ appVersion: "1.3.0" }) }), rt)).toBe("verified on app 1.3.0, now 1.2.3");
    expect(revalidation(lesson({ verified: verification({ appVersion: "1.2.9" }) }), rt)).toBeNull();
  });

  it("is null for a non-active lesson", () => {
    expect(revalidation(lesson({ status: "candidate", verified: null }), rt)).toBeNull();
    expect(revalidation(lesson({ status: "retired", verified: verification({ model: "old" }) }), rt)).toBeNull();
  });
});

describe("promotion", () => {
  it("promotes when the case fails before, passes after, and transfer holds", () => {
    expect(promotion(verification({ before: { passed: 0, of: 2 }, after: { passed: 2, of: 2 }, transfer: { held: 3, of: 3 } }))).toEqual({
      promote: true,
      why: "fixed its case and held on 3 other case(s)",
    });
  });

  it("refuses when the case already passes without it", () => {
    expect(promotion(verification({ before: { passed: 2, of: 2 } }))).toEqual({ promote: false, why: "its case already passes without it" });
    expect(promotion(verification({ before: { passed: 0, of: 0 } }))).toEqual({ promote: false, why: "its case already passes without it" });
  });

  it("refuses when the case still fails with it", () => {
    expect(promotion(verification({ before: { passed: 0, of: 2 }, after: { passed: 1, of: 2 } }))).toEqual({ promote: false, why: "its case still fails with it" });
    expect(promotion(verification({ before: { passed: 0, of: 1 }, after: { passed: 0, of: 0 } }))).toEqual({ promote: false, why: "its case still fails with it" });
  });

  it("refuses when there is no other case to check transfer on", () => {
    expect(promotion(verification({ transfer: { held: 0, of: 0 } }))).toEqual({ promote: false, why: "no other case to check transfer on" });
  });

  it("refuses when transfer changed other cases", () => {
    expect(promotion(verification({ transfer: { held: 1, of: 3 } }))).toEqual({ promote: false, why: "changed the result of 2 of 3 other cases" });
  });
});
