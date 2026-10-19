import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiveUpdate } from "../src/shared/types";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import { LearnDb } from "../src/main/learn/db";
import { createLearner, type Learner } from "../src/main/learn";
import { failingRepeats, healthOf, isCorrection, mergeSignals, overNorm, roundSignals } from "../src/main/learn/signals";
import { sanitizeLearn } from "../src/main/settings";
import { LEARN_DEFAULTS, type BackgroundRun, type LearnSettings, type TurnScore } from "../src/shared/learn";
import { catalog, closeAfter, tempDir } from "./helpers";

const facts = { evidence: [], check: null, fixRound: false, denied: 0, stopped: false, failedCommands: [], steps: 3, tokens: 2000 };

describe("scorecard signals", () => {
  it("reads corrections from the next message's first line", () => {
    for (const t of ["No, that's not it", "wrong file", "revert that", "That's not what I asked", "it still fails", "you didn't run the tests", "Why did you delete it?"]) {
      expect(isCorrection(t), t).toBe(true);
    }
    for (const t of ["Now add a test for zero", "nothing else, thanks", "Great, next: the README", "Know what, also bump the version"]) {
      expect(isCorrection(t), t).toBe(false);
    }
  });

  it("counts a command failing 3× in any order as a loop", () => {
    expect(failingRepeats(["npm test", "ls", "npm test", " npm test "])).toEqual([{ command: "npm test", count: 3 }]);
    expect(failingRepeats(["npm test", "npm test"])).toEqual([]);
  });

  it("flags a turn far past the project's healthy norm, only with enough history", () => {
    const norm = Array.from({ length: 5 }, () => ({ steps: 4, tokens: 10_000 }));
    expect(overNorm({ steps: 13, tokens: 1000 }, norm)).toMatch(/13 tool calls/);
    expect(overNorm({ steps: 2, tokens: 31_000 }, norm)).toMatch(/31k tokens/);
    expect(overNorm({ steps: 12, tokens: 30_000 }, norm)).toBeNull();
    expect(overNorm({ steps: 99, tokens: 1e6 }, norm.slice(0, 4))).toBeNull();
  });

  it("maps a round's facts to signals and a health", () => {
    expect(roundSignals(facts, [])).toEqual([]);
    expect(healthOf([])).toBe("ok");
    const s = roundSignals(
      { ...facts, evidence: ["Changed existing tests: a.test.ts. Check they weren't loosened to pass.", "Says tests or checks pass, but none ran this turn."], denied: 2, stopped: true, failedCommands: ["x", "x", "x"] },
      [],
    );
    expect(s.map((x) => `${x.kind}:${x.level}`)).toEqual(["evidence:warn", "evidence:fail", "denied:warn", "stopped:warn", "loop:warn"]);
    expect(healthOf(s)).toBe("fail");
    expect(healthOf(s.filter((x) => x.level === "warn"))).toBe("warn");
  });

  it("folds a fix round that made the check pass into the turn", () => {
    const first = roundSignals({ ...facts, check: { ok: false, command: "npm test" } }, []);
    const fix = roundSignals({ ...facts, check: { ok: true, command: "npm test" }, fixRound: true }, []);
    const merged = mergeSignals(first, fix);
    expect(merged.map((x) => x.kind)).toEqual(["check-fixed"]);
    expect(healthOf(merged)).toBe("warn");
    expect(mergeSignals(first, first)).toEqual(first);
  });
});

describe("learn settings", () => {
  it("is off for every project by default and sanitises what it stores", () => {
    expect(sanitizeLearn(undefined)).toEqual(LEARN_DEFAULTS);
    const s = sanitizeLearn({
      enabledProjects: ["a", "a", 3 as unknown as string],
      dailyTokens: 10,
      background: { agent: "codex", model: "" },
      backgroundByProject: { p: { agent: "opencode", model: "x" }, q: { agent: 1 } as unknown as { agent: string; model: string } },
    });
    expect(s).toEqual({ enabledProjects: ["a"], dailyTokens: 1000, memoryDailyTokens: 200_000, background: null, backgroundByProject: { p: { agent: "opencode", model: "x" } } });
  });

  it("defaults and clamps the memory cap within 1k–5M", () => {
    expect(sanitizeLearn(undefined).memoryDailyTokens).toBe(200_000);
    expect(sanitizeLearn({ memoryDailyTokens: 10 }).memoryDailyTokens).toBe(1000);
    expect(sanitizeLearn({ memoryDailyTokens: 9_000_000 }).memoryDailyTokens).toBe(5_000_000);
    expect(sanitizeLearn({ memoryDailyTokens: 12_345 }).memoryDailyTokens).toBe(12_345);
  });
});

function fakeDriver(script: (input: TurnInput) => Promise<void>): AgentDriver & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "fake",
    label: "Fake",
    defaultModel: "fake-1",
    capabilities: SAFE_DEFAULTS,
    skillsDelivery: { mode: "none" },
    skillCallPrefix: "",
    models: () => [{ id: "fake-1", label: "Fake 1" }],
    prompts,
    async runTurn(input) {
      prompts.push(input.prompt);
      await script(input);
    },
  };
}

/** A committed repo as the project, a service with a learner, and the learn settings to flip. */
function setupRepo(script: (input: TurnInput, n: number) => Promise<void>, opts: { on?: boolean; revertWindowMs?: number } = {}) {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const dir = tempDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "math.ts"), "export const add = (a, b) => a - b;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  let n = 0;
  const driver = fakeDriver((input) => script(input, n++));
  const updates: LiveUpdate[] = [];
  const service = new Service(store, () => catalog(), [driver], (u) => updates.push(u));
  const project = store.addProject(dir);
  const settings: LearnSettings = { ...LEARN_DEFAULTS, enabledProjects: opts.on === false ? [] : [project.id] };
  const db = new LearnDb(store.sql);
  const learner = createLearner({ db, settings: () => settings, broadcast: (u) => updates.push(u), revertWindowMs: opts.revertWindowMs, log: () => {} });
  closeAfter(() => learner.dispose());
  service.setLearner(learner);
  const thread = service.createThread(project.id);
  return { store, service, driver, thread, dir, db, learner, updates, settings };
}

/** Let the learner's background chain settle. */
const settle = (l: Learner) => l.afterTurn({ thread: { projectId: "none" } } as never, null);
const scoresOf = (updates: LiveUpdate[]): TurnScore[] => updates.flatMap((u) => (u.type === "turn-score" ? [u.score] : []));
const say = (input: TurnInput, text: string) => input.onEvent({ kind: "assistant-text", text });

describe("the scorecard in Service.send", () => {
  it("does nothing for a project that isn't opted in: same prompt, no scores", async () => {
    const off = setupRepo(async (input) => say(input, "Done."), { on: false });
    const plain = setupRepo(async (input) => say(input, "Done."));
    plain.service.setLearner(null);
    await off.service.send({ threadId: off.thread.id, text: "fix add" });
    await plain.service.send({ threadId: plain.thread.id, text: "fix add" });
    await settle(off.learner);
    expect(off.driver.prompts).toEqual(plain.driver.prompts);
    expect(off.db.threadScores(off.thread.id)).toEqual([]);
    expect(scoresOf(off.updates)).toEqual([]);
    expect(off.store.listEvents(off.thread.id).map((e) => e.event)).toEqual(plain.store.listEvents(plain.thread.id).map((e) => e.event));
  });

  it("scores an honest turn ok and tells the renderer", async () => {
    const { service, thread, db, learner, updates, driver } = setupRepo(async (input) => {
      writeFileSync(join(input.cwd, "src", "math.ts"), "export const add = (a, b) => a + b;\n");
      input.onEvent({ kind: "tool-use", toolUseId: "r1", name: "Run", summary: "npm test", payload: { command: "npm test" } });
      say(input, "Fixed. All tests pass.");
      input.onEvent({ kind: "turn-end", costUsd: null, inputTokens: 900, outputTokens: 100, durationMs: 1 });
    });
    await service.send({ threadId: thread.id, text: "fix add" });
    await settle(learner);
    expect(driver.prompts).toEqual(["fix add"]);
    const [row] = db.threadScores(thread.id);
    expect(row).toMatchObject({ health: "ok", signals: [], steps: 1, tokens: 1000, agent: "fake" });
    expect(scoresOf(updates)).toEqual([{ threadId: thread.id, userSeq: row!.userSeq, health: "ok", signals: [] }]);
    expect(learner.scores(thread.id)).toHaveLength(1);
  });

  it("fails a turn the evidence gate flags, and warns on denials and repeated failures", async () => {
    const { service, thread, db, learner } = setupRepo(async (input, n) => {
      if (n === 0) {
        writeFileSync(join(input.cwd, "src", "math.ts"), "export const add = (a, b) => a + b;\n");
        say(input, "Done. All tests pass.");
        return;
      }
      await input.requestPermission({ toolName: "Bash", summary: "rm -rf x", canAlwaysAllow: false });
      for (const id of ["a", "b", "c"]) {
        input.onEvent({ kind: "tool-use", toolUseId: id, name: "Run", summary: "make", payload: { command: "make" } });
        input.onEvent({ kind: "tool-result", toolUseId: id, isError: true, summary: "boom" });
      }
    });
    await service.send({ threadId: thread.id, text: "fix add" });
    const second = service.send({ threadId: thread.id, text: "build it" });
    // Deny the permission card the second turn raises.
    for (let i = 0; i < 200 && !service.pendingState().permissions.length; i++) await new Promise((r) => setTimeout(r, 10));
    const pending = service.pendingState().permissions[0]!;
    service.respondPermission(pending.requestId, "deny");
    await second;
    await settle(learner);
    const [first, next] = db.threadScores(thread.id);
    expect(first).toMatchObject({ health: "fail" });
    expect(first!.signals.map((s) => s.detail)).toEqual(["Says tests or checks pass, but none ran this turn."]);
    expect(next!.health).toBe("warn");
    expect(next!.signals.map((s) => s.kind)).toEqual(["denied", "loop"]);
  });

  it("folds an automatic fix round into the turn it fixes", async () => {
    const { store, service, thread, db, learner, dir } = setupRepo(async (input, n) => {
      writeFileSync(join(input.cwd, "src", `fix${n}.ts`), "x\n");
      input.onEvent({ kind: "tool-use", toolUseId: `e${n}`, name: "Edit", summary: "x" });
      input.onEvent({ kind: "tool-result", toolUseId: `e${n}`, isError: false, summary: "ok" });
    });
    // Fails until the fix round writes fix1.ts.
    store.setCheckCommand(thread.projectId, `"${process.execPath}" -e "process.exit(require('fs').existsSync('src/fix1.ts') ? 0 : 3)"`, 1);
    await service.send({ threadId: thread.id, text: "add fix" });
    // The fix round starts after the first send returns: wait until its score lands and the thread is idle.
    for (let i = 0; i < 300 && (service.isRunning(thread.id) || !db.threadScores(thread.id)[0]?.signals.some((s) => s.kind === "check-fixed")); i++) await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 100 && service.isRunning(thread.id); i++) await new Promise((r) => setTimeout(r, 20));
    await settle(learner);
    const rows = db.threadScores(thread.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signals.map((s) => s.kind)).toEqual(["check-fixed"]);
    expect(rows[0]!.health).toBe("warn");
    expect(dir).toBeTruthy();
  });

  it("marks the previous turn failed when the next message corrects it", async () => {
    const { service, thread, db, learner } = setupRepo(async (input) => say(input, "Done."));
    await service.send({ threadId: thread.id, text: "rename the helper" });
    await settle(learner);
    await service.send({ threadId: thread.id, text: "No, that's the wrong helper" });
    await settle(learner);
    const [first, second] = db.threadScores(thread.id);
    expect(first!.health).toBe("fail");
    expect(first!.signals[0]).toMatchObject({ kind: "correction", level: "fail" });
    expect(second!.health).toBe("ok");
  });

  it("marks a turn whose edits were undone within the window", async () => {
    const { service, thread, db, learner, dir } = setupRepo(async (input, n) => {
      if (n === 0) writeFileSync(join(input.cwd, "src", "math.ts"), "export const add = (a, b) => a * b;\n");
      say(input, "ok");
    });
    await service.send({ threadId: thread.id, text: "change add" });
    await settle(learner);
    // The user puts the file back, then sends the next message.
    writeFileSync(join(dir, "src", "math.ts"), "export const add = (a, b) => a - b;\n");
    await service.send({ threadId: thread.id, text: "now the README" });
    await settle(learner);
    const [first] = db.threadScores(thread.id);
    expect(first!.signals.map((s) => s.kind)).toEqual(["reverted"]);
    expect(first!.signals[0]!.detail).toContain("src/math.ts");
  });

  it("catches an undo by the window's own deadline, with no next message", async () => {
    const { service, thread, db, learner, dir } = setupRepo(
      async (input, n) => {
        if (n === 0) writeFileSync(join(input.cwd, "src", "math.ts"), "export const add = (a, b) => a * b;\n");
      },
      { revertWindowMs: 150 },
    );
    await service.send({ threadId: thread.id, text: "change add" });
    await settle(learner);
    writeFileSync(join(dir, "src", "math.ts"), "export const add = (a, b) => a - b;\n");
    await new Promise((r) => setTimeout(r, 300));
    await settle(learner);
    expect(db.threadScores(thread.id)[0]!.signals.map((s) => s.kind)).toEqual(["reverted"]);
  });

  it("doesn't call an edit reverted once the window has passed", async () => {
    const { service, thread, db, learner, dir } = setupRepo(
      async (input, n) => {
        if (n === 0) writeFileSync(join(input.cwd, "src", "math.ts"), "export const add = (a, b) => a * b;\n");
      },
      { revertWindowMs: 1 },
    );
    await service.send({ threadId: thread.id, text: "change add" });
    await settle(learner);
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, "src", "math.ts"), "export const add = (a, b) => a - b;\n");
    await service.send({ threadId: thread.id, text: "next" });
    await settle(learner);
    expect(db.threadScores(thread.id)[0]!.signals).toEqual([]);
  });
});

describe("LearnDb", () => {
  it("keeps the budget per project and day", () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const db = new LearnDb(store.sql);
    db.spend("p", "2026-10-15", 100);
    db.spend("p", "2026-10-15", 50.4);
    db.spend("q", "2026-10-15", 7);
    expect(db.spent("p", "2026-10-15")).toBe(150);
    expect(db.spent("p", "2026-10-16")).toBe(0);
    db.saveReplay("k", "case", null, true, 1234);
    expect(db.cachedReplay("k")).toEqual({ pass: true, tokens: 1234 });
    expect(db.cachedReplay("nope")).toBeNull();
  });

  it("records background runs, sums them per purpose and lists newest first", () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const db = new LearnDb(store.sql);
    const run = (over: Partial<BackgroundRun> & Pick<BackgroundRun, "purpose" | "tokens" | "at">): BackgroundRun => ({
      projectId: "p",
      day: "2026-10-15",
      agent: "codex",
      model: "m-mini",
      estimated: true,
      ok: true,
      escalated: false,
      ...over,
    });
    db.recordRun(run({ purpose: "memory", tokens: 10, at: 1 }));
    db.recordRun(run({ purpose: "memory", tokens: 5, at: 2 }));
    db.recordRun(run({ purpose: "lesson", tokens: 7, at: 3 }));
    db.recordRun(run({ purpose: "memory", tokens: 100, at: 4, projectId: "q" }));
    expect(db.runTokens("p", "2026-10-15", "memory")).toBe(15);
    expect(db.runTokens("p", "2026-10-15", "lesson")).toBe(7);
    expect(db.runTokens("p", "2026-10-16", "memory")).toBe(0);
    expect(db.runs("p").map((r) => r.at)).toEqual([3, 2, 1]);
    expect(db.runs("p", 2).map((r) => r.at)).toEqual([3, 2]);
    expect(db.runs("p")[0]).toEqual({ purpose: "lesson", projectId: "p", day: "2026-10-15", agent: "codex", model: "m-mini", tokens: 7, estimated: true, ok: true, escalated: false, at: 3 });
  });
});
