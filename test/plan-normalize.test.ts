import { describe, expect, it } from "vitest";
import { normalizePlan, samePlan } from "../src/shared/plan";

describe("normalizePlan", () => {
  it("reads Claude's and OpenCode's todos, dropping priority and activeForm", () => {
    expect(
      normalizePlan([
        { content: " Read the code ", status: "completed", activeForm: "Reading", priority: "high" },
        { content: "Fix it", status: "in_progress" },
      ]),
    ).toEqual([
      { content: "Read the code", status: "completed" },
      { content: "Fix it", status: "in_progress" },
    ]);
  });

  it("reads Codex's steps and its inProgress status", () => {
    expect(normalizePlan([{ step: "Plan", status: "inProgress" }, { step: "Ship", status: "pending" }])).toEqual([
      { content: "Plan", status: "in_progress" },
      { content: "Ship", status: "pending" },
    ]);
  });

  it("leaves cancelled items out and counts unknown statuses as pending", () => {
    expect(normalizePlan([{ content: "a", status: "cancelled" }, { content: "b", status: "blocked" }, { content: "c" }])).toEqual([
      { content: "b", status: "pending" },
      { content: "c", status: "pending" },
    ]);
  });

  it("keeps only the first in_progress item", () => {
    expect(normalizePlan([{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }])).toEqual([
      { content: "a", status: "in_progress" },
      { content: "b", status: "pending" },
    ]);
  });

  it("is null for anything that isn't a todo list", () => {
    expect(normalizePlan(undefined)).toBeNull();
    expect(normalizePlan("x")).toBeNull();
    expect(normalizePlan([{ status: "pending" }])).toBeNull();
    expect(normalizePlan([{ content: "  ", status: "pending" }])).toBeNull();
    expect(normalizePlan([["a"]])).toBeNull();
    expect(normalizePlan([])).toEqual([]);
  });
});

describe("samePlan", () => {
  it("compares content and status in order", () => {
    const a = [{ content: "a", status: "pending" as const }];
    expect(samePlan(a, [{ content: "a", status: "pending" }])).toBe(true);
    expect(samePlan(a, [{ content: "a", status: "completed" }])).toBe(false);
    expect(samePlan(a, [])).toBe(false);
  });
});
