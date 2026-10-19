// Dataset splits (roadmap P8.1): deterministic train/validation/holdout
// assignment, the sealed holdout, and the leakage checks over real and
// synthetic tasks. Zero model calls.

import { describe, expect, it } from "vitest";
import { loadTasks } from "../evals/run";
import { assignSplits, checkSplits, familyOf, forSplit, promptWords, similarity, splitOf, splitSummary } from "../evals/lib/splits";
import type { Split, Task } from "../evals/lib/types";

const SPLITS: Split[] = ["train", "validation", "holdout"];

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    tags: ["capability"],
    tier: "full",
    fixture: "empty",
    prompt: `task ${id}`,
    mode: "plan",
    graders: [],
    budget: { maxSteps: 1, maxInputTokens: 1000, timeoutMs: 1000 },
    ...over,
  };
}

describe("splitOf", () => {
  it("is deterministic and honours an explicit pin", () => {
    const t = task("stable-id");
    expect(splitOf(t)).toBe(splitOf(t));
    expect(splitOf(t, "v1")).toBe(splitOf(t, "v1"));
    expect(SPLITS).toContain(splitOf(t));
    expect(splitOf(task("pinned", { split: "holdout" }))).toBe("holdout");
    expect(splitOf(task("pinned", { split: "train" }), "other-seed")).toBe("train");
  });

  it("keeps a known family and an explicit family in one split", () => {
    expect(familyOf(task("route-skill-2"))).toBe("route-skill");
    expect(familyOf(task("standalone-task"))).toBe("standalone-task");
    const known = ["route-skill-1", "route-skill-2", "route-skill-3"].map((id) => task(id));
    expect(new Set(known.map((t) => splitOf(t))).size).toBe(1);
    const explicit = [task("a", { family: "custom" }), task("b", { family: "custom" }), task("c", { family: "custom" })];
    expect(new Set(explicit.map((t) => splitOf(t))).size).toBe(1);
  });

  it("comes out near the 60/20/20 shares", () => {
    const tasks = Array.from({ length: 1000 }, (_, i) => task(`synthetic-${i}`));
    const counts: Record<Split, number> = { train: 0, validation: 0, holdout: 0 };
    for (const t of tasks) counts[splitOf(t)]++;
    expect(Math.abs(counts.train - 600)).toBeLessThanOrEqual(70);
    expect(Math.abs(counts.validation - 200)).toBeLessThanOrEqual(70);
    expect(Math.abs(counts.holdout - 200)).toBeLessThanOrEqual(70);
  });
});

describe("assignSplits", () => {
  it("gives a family with conflicting pins the first task's split by id", () => {
    const splits = assignSplits([task("fam-b", { family: "shared", split: "holdout" }), task("fam-a", { family: "shared", split: "train" })]);
    expect([splits.get("fam-a"), splits.get("fam-b")]).toEqual(["train", "train"]);
  });
});

describe("promptWords and similarity", () => {
  it("drops stopwords and short words, and computes Jaccard similarity", () => {
    const words = promptWords(task("w", { prompt: "The quick brown fox and the lazy dog", turns: [{ prompt: "jumps over a fox" }] }));
    expect(words.has("the")).toBe(false);
    expect(words.has("and")).toBe(false);
    expect(words.has("fox")).toBe(true);
    expect(words.has("jumps")).toBe(true);
    expect([...words].every((w) => w.length >= 3)).toBe(true);
    expect(similarity(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(similarity(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(similarity(new Set<string>(), new Set(["b"]))).toBe(0);
  });
});

describe("checkSplits", () => {
  it("passes a clean set", () => {
    expect(checkSplits([task("one", { prompt: "alpha beta gamma delta" }), task("two", { prompt: "epsilon zeta eta theta" })])).toEqual([]);
  });

  it("flags a near-duplicate pair in different splits", () => {
    const problems = checkSplits([
      task("dup-a", { prompt: "Deploy the staging service to the staging cluster now", split: "train" }),
      task("dup-b", { prompt: "Deploy the staging service to the staging cluster now", split: "validation" }),
    ]);
    expect(problems).toEqual([{ kind: "near-duplicate", tasks: ["dup-a", "dup-b"], detail: "similarity 1.00, same fixture" }]);
  });

  it("flags a family whose explicit pins disagree", () => {
    const problems = checkSplits([task("fam-a", { family: "shared", split: "train" }), task("fam-b", { family: "shared", split: "holdout" })]);
    expect(problems.map((p) => p.kind)).toEqual(["family-conflict"]);
    expect(problems[0]!.tasks).toEqual(["fam-a", "fam-b"]);
    expect(problems[0]!.detail).toContain("shared");
  });
});

describe("forSplit", () => {
  it("throws on the sealed holdout unless released", () => {
    const tasks = [task("h1", { split: "holdout" }), task("t1", { split: "train" })];
    expect(() => forSplit(tasks, "holdout")).toThrow(/sealed/);
    expect(forSplit(tasks, "holdout", { sealed: false }).map((t) => t.id)).toEqual(["h1"]);
    expect(forSplit(tasks, "train").map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("the real task set", () => {
  const tasks = loadTasks();

  it("has no leakage across splits", () => {
    expect(checkSplits(tasks)).toEqual([]);
  });

  it("fills train, validation and holdout", () => {
    expect(forSplit(tasks, "train").length).toBeGreaterThan(0);
    expect(forSplit(tasks, "validation").length).toBeGreaterThan(0);
    expect(forSplit(tasks, "holdout", { sealed: false }).length).toBeGreaterThan(0);
  });

  it("summarises every split with its task ids", () => {
    const summary = splitSummary(tasks);
    expect(summary).toContain("train ");
    expect(summary).toContain("validation ");
    expect(summary).toContain("holdout ");
    expect(summary).toContain("route-skill-1");
  });
});
