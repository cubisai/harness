import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cacheKey,
  compareBaseline,
  diffRuns,
  findCached,
  hashDir,
  listRuns,
  previousRun,
  readBaseline,
  redact,
  runFileName,
  saveBaseline,
  saveRun,
  summarize,
} from "../evals/lib/store";
import type { RunMeta, RunResult, Task, TaskResult, TrialResult } from "../evals/lib/types";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-store-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function trial(over: Partial<TrialResult> = {}): TrialResult {
  return {
    pass: true,
    score: 1,
    graders: [],
    overBudget: false,
    harnessError: null,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    steps: 3,
    toolCalls: 2,
    durationMs: 1000,
    costUsd: 0.01,
    events: [],
    ...over,
  };
}

function task(id: string, over: Partial<TaskResult> = {}): TaskResult {
  const trials = over.trials ?? [trial()];
  return {
    id,
    tags: ["capability"],
    cacheKey: `ck-${id}`,
    cached: false,
    trials,
    passAtK: trials.some((t) => t.pass),
    passHatK: trials.every((t) => t.pass),
    ...over,
  };
}

function run(over: { meta?: Partial<RunMeta>; tasks?: TaskResult[] } = {}): RunResult {
  return {
    meta: {
      tier: "smoke",
      agent: "native",
      model: "deepseek-v4.1-flash",
      protocol: "native",
      harnessHash: "h1",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1000,
      ...over.meta,
    },
    tasks: over.tasks ?? [],
  };
}

function fixtureTask(prompt = "do a thing"): Task {
  return {
    id: "t1",
    tags: ["capability"],
    tier: "smoke",
    fixture: "basic",
    prompt,
    mode: "plan",
    graders: [],
    budget: { maxSteps: 10, maxInputTokens: 1000, timeoutMs: 1000 },
  };
}

describe("hashDir", () => {
  it("is stable and changes when a file changes", () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.txt"), "hello");
    writeFileSync(join(dir, "b.txt"), "world");
    const h1 = hashDir(dir);
    expect(hashDir(dir)).toBe(h1);

    writeFileSync(join(dir, "a.txt"), "hello!");
    expect(hashDir(dir)).not.toBe(h1);
  });

  it("hashes nested paths the same across directories", () => {
    const dirA = tmp();
    mkdirSync(join(dirA, "nested", "deep"), { recursive: true });
    writeFileSync(join(dirA, "nested", "deep", "f.txt"), "data");

    const dirB = tmp();
    mkdirSync(join(dirB, "nested", "deep"), { recursive: true });
    writeFileSync(join(dirB, "nested", "deep", "f.txt"), "data");

    const dirC = tmp();
    mkdirSync(join(dirC, "nested"), { recursive: true });
    writeFileSync(join(dirC, "nested", "f.txt"), "data");

    expect(hashDir(dirA)).toBe(hashDir(dirB));
    expect(hashDir(dirA)).not.toBe(hashDir(dirC));
  });

  it("hashes a missing dir as the empty string", () => {
    expect(hashDir(join(tmp(), "nope"))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("cacheKey", () => {
  it("changes with the model, task prompt and hidden dir content", () => {
    const dir = tmp();
    mkdirSync(join(dir, "basic"), { recursive: true });
    mkdirSync(join(dir, "basic.hidden"), { recursive: true });
    writeFileSync(join(dir, "basic", "f.txt"), "visible");
    writeFileSync(join(dir, "basic.hidden", "test.js"), "assert(true)");
    const fixtureDir = join(dir, "basic");

    const base = cacheKey(fixtureTask(), fixtureDir, "model-a", "native", "h1");
    expect(cacheKey(fixtureTask(), fixtureDir, "model-b", "native", "h1")).not.toBe(base);
    expect(cacheKey(fixtureTask("different prompt"), fixtureDir, "model-a", "native", "h1")).not.toBe(base);

    writeFileSync(join(dir, "basic.hidden", "test.js"), "assert(false)");
    expect(cacheKey(fixtureTask(), fixtureDir, "model-a", "native", "h1")).not.toBe(base);
  });
});

describe("redact", () => {
  it("hides API key values and leaves short values", () => {
    const env = { FOO_API_KEY: "supersecretvalue", FOO_TOKEN: "abc", OTHER_VALUE: "keepme-long" };
    const out = redact(`key=${env.FOO_API_KEY} tok=${env.FOO_TOKEN} other=${env.OTHER_VALUE}`, env);
    expect(out).not.toContain(env.FOO_API_KEY);
    expect(out).toContain("***");
    expect(out).toContain("abc");
    expect(out).toContain("keepme-long");
  });

  it("replaces every occurrence", () => {
    const env = { MY_SECRET: "abcdefgh" };
    const out = redact(`${env.MY_SECRET} and ${env.MY_SECRET}`, env);
    expect(out.match(/\*\*\*/g)).toHaveLength(2);
    expect(out).not.toContain("abcdefgh");
  });
});

describe("runFileName", () => {
  it("slugs the model and strips punctuation from the timestamp", () => {
    const name = runFileName({
      tier: "smoke",
      agent: "native",
      model: "TokenHarbor/Claude Haiku 5.5",
      protocol: "native",
      harnessHash: "h1",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1,
    });
    expect(name).toBe("smoke-tokenharbor-claude-haiku-5-5-2026-01-01T00-00-00-000Z.json");
  });
});

describe("saveRun / listRuns", () => {
  it("writes a redacted run file and reads it back newest-first", () => {
    const dir = tmp();
    const secret = "topsecretvalue";
    const env = { FOO_API_KEY: secret };

    const older = run({
      meta: { startedAt: "2026-01-01T00:00:00.000Z" },
      tasks: [task("a", { trials: [trial({ events: [{ kind: "error", text: `leaked ${secret}` }] })] })],
    });
    const newer = run({ meta: { startedAt: "2026-01-02T00:00:00.000Z" }, tasks: [task("b")] });

    const olderPath = saveRun(dir, older, env);
    saveRun(dir, newer, env);
    const raw = readFileSync(olderPath, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("***");

    const loaded = listRuns(dir);
    expect(loaded.map((r) => r.meta.startedAt)).toEqual([
      "2026-01-02T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
    expect(listRuns(join(dir, "missing"))).toEqual([]);
  });
});

describe("findCached", () => {
  it("returns a hit, a miss, and skips a harness-errored newest run", () => {
    const dir = tmp();
    saveRun(
      dir,
      run({ meta: { startedAt: "2026-01-01T00:00:00.000Z" }, tasks: [task("clean", { cacheKey: "k1" })] }),
      {},
    );
    saveRun(
      dir,
      run({
        meta: { startedAt: "2026-01-02T00:00:00.000Z" },
        tasks: [task("broken", { cacheKey: "k1", trials: [trial({ harnessError: "auth 401" })] })],
      }),
      {},
    );

    const hit = findCached(dir, "k1");
    expect(hit?.id).toBe("clean");
    expect(hit?.cached).toBe(true);
    expect(findCached(dir, "nope")).toBeNull();

    const only = tmp();
    saveRun(
      only,
      run({ tasks: [task("broken", { cacheKey: "k2", trials: [trial({ harnessError: "5xx" })] })] }),
      {},
    );
    expect(findCached(only, "k2")).toBeNull();
  });
});

describe("previousRun", () => {
  it("picks the newest earlier run of the same tier and model", () => {
    const dir = tmp();
    saveRun(dir, run({ meta: { startedAt: "2026-01-01T00:00:00.000Z", model: "m1" } }), {});
    saveRun(dir, run({ meta: { startedAt: "2026-01-02T00:00:00.000Z", model: "m1" } }), {});
    saveRun(dir, run({ meta: { startedAt: "2026-01-03T00:00:00.000Z", tier: "full", model: "m1" } }), {});
    saveRun(dir, run({ meta: { startedAt: "2026-01-04T00:00:00.000Z", model: "m2" } }), {});

    expect(previousRun(dir, "smoke", "m1", "2026-01-03T12:00:00.000Z")?.meta.startedAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
    expect(previousRun(dir, "full", "m1", "2026-01-04T12:00:00.000Z")?.meta.startedAt).toBe(
      "2026-01-03T00:00:00.000Z",
    );
    expect(previousRun(dir, "smoke", "m1", "2026-01-01T00:00:00.000Z")).toBeNull();
    expect(previousRun(dir, "smoke", "m9", "2026-01-05T00:00:00.000Z")).toBeNull();
  });
});

describe("summarize", () => {
  it("reports pass/fail, cache-hit % and an unknown cost", () => {
    const r = run({
      tasks: [
        task("passes", {
          trials: [trial({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 100, steps: 2, costUsd: 0.05 })],
        }),
        task("fails", {
          trials: [trial({ pass: false, score: 0, inputTokens: 50, outputTokens: 5, steps: 1, costUsd: null })],
        }),
      ],
    });
    const text = summarize(r);
    expect(text).toContain("PASS");
    expect(text).toContain("FAIL");
    expect(text).toContain("cache-hit 40%");
    expect(text).toContain("unknown");
    expect(text).toContain("1/2 passed");
  });

  it("prints pass^k for multi-trial tasks", () => {
    const r = run({ tasks: [task("mixed", { trials: [trial(), trial({ pass: false, score: 0 })] })] });
    expect(summarize(r)).toContain("pass^k no");
  });
});

describe("diffRuns", () => {
  it("reports newly failing, newly passing and the token delta", () => {
    const prev = run({
      meta: { startedAt: "2026-01-01T00:00:00.000Z" },
      tasks: [
        task("a", { trials: [trial({ inputTokens: 100 })] }),
        task("b", { trials: [trial({ pass: false, score: 0, inputTokens: 0 })] }),
      ],
    });
    const cur = run({
      meta: { startedAt: "2026-01-02T00:00:00.000Z" },
      tasks: [
        task("a", { trials: [trial({ pass: false, score: 0, inputTokens: 0 })] }),
        task("b", { trials: [trial({ inputTokens: 200 })] }),
      ],
    });

    const d = diffRuns(prev, cur);
    expect(d).toContain("newly failing: a");
    expect(d).toContain("newly passing: b");
    expect(d).toContain("+100%");
    expect(d).toContain("2026-01-01T00:00:00.000Z");
    expect(diffRuns(null, cur)).toBe("");
  });

  it("omits the token line when the previous input sum is zero", () => {
    const prev = run({ tasks: [task("a", { trials: [trial({ inputTokens: 0 })] })] });
    const cur = run({ tasks: [task("a", { trials: [trial({ inputTokens: 5 })] })] });
    expect(diffRuns(prev, cur)).not.toContain("tokens:");
  });

  it("omits the token line when every current task came from the cache", () => {
    const prev = run({ tasks: [task("a", { trials: [trial({ inputTokens: 100 })] })] });
    const cur = run({ tasks: [task("a", { cached: true, trials: [trial({ inputTokens: 100 })] })] });
    expect(diffRuns(prev, cur)).not.toContain("tokens:");
  });
});

describe("baseline", () => {
  it("saves pass/fail per tier+model, merges partial runs, and reports changes", () => {
    const path = join(tmp(), "baseline.json");
    expect(readBaseline(path)).toEqual({});
    const meta = { tier: "full" as const, model: "m" };
    saveBaseline(path, run({ meta, tasks: [task("b"), task("a", { passAtK: false })] }));
    saveBaseline(path, run({ meta, tasks: [task("c")] }));
    saveBaseline(path, run({ meta: { tier: "smoke", model: "m" }, tasks: [task("a")] }));
    const base = readBaseline(path);
    expect(base["full|m"]).toEqual({ a: "fail", b: "pass", c: "pass" });
    expect(Object.keys(base["full|m"]!)).toEqual(["a", "b", "c"]);
    expect(base["smoke|m"]).toEqual({ a: "pass" });

    expect(compareBaseline(base, run({ meta, tasks: [task("a"), task("b", { passAtK: false }), task("c")] }))).toBe("below baseline: b\nabove baseline: a");
    expect(compareBaseline(base, run({ meta, tasks: [task("b"), task("c")] }))).toBe("matches baseline");
    expect(compareBaseline(base, run({ meta: { tier: "full", model: "other" } }))).toBe("");
  });
});
