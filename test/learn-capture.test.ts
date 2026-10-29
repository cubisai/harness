import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiveUpdate, ModelOption } from "../src/shared/types";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import { LearnDb } from "../src/main/learn/db";
import { createLearner } from "../src/main/learn";
import { backgroundShot, pickBackground } from "../src/main/learn/background";
import { captureCase, gradersFor, heldOutId, listCases, readCase } from "../src/main/learn/cases";
import type { PreTurn } from "../src/main/learn/snapshot";
import { LEARN_DEFAULTS, type LearnSettings, type TurnSignal } from "../src/shared/learn";
import { catalog, closeAfter, tempDir } from "./helpers";

const sig = (kind: TurnSignal["kind"], detail: string, level: TurnSignal["level"] = "fail"): TurnSignal => ({ kind, level, detail });
const pre = (overlay: Record<string, string | null>, complete = true): PreTurn => ({
  headSha: "abc123",
  overlay: new Map(Object.entries(overlay).map(([k, v]) => [k, v === null ? null : Buffer.from(v)])),
  complete,
  at: 1,
});

describe("case graders from signals", () => {
  const preBytes = async (rel: string) => (rel === "src/a.test.ts" ? Buffer.from("it('a')\n") : null);

  it("maps a failed check, harmed tests, an unbacked claim and a revert to machine graders", async () => {
    const g = await gradersFor({
      signals: [sig("check-failed", "npm test failed"), sig("evidence", "Deleted test files: src/a.test.ts."), sig("evidence", "Says tests or checks pass, but none ran this turn.")],
      changed: ["src/a.test.ts", "src/a.ts"],
      checkCommand: "npm test",
      reverted: ["src/new.ts"],
      preBytes,
    });
    expect(g!.graders).toEqual([
      { type: "command", run: "npm test", timeoutMs: 300_000 },
      { type: "file", path: "src/a.test.ts", unchanged: true },
      { type: "event", noFalseClaim: true },
      { type: "file", path: "src/new.ts", exists: false },
    ]);
    expect([...g!.expect.keys()]).toEqual(["src/a.test.ts"]);
    expect(g!.text).toBe("the check command passes; src/a.test.ts unchanged; no unbacked pass claim; src/new.ts left as you had it");
  });

  it("has no grader for a correction alone, a warning, or a failed check without a command", async () => {
    expect(await gradersFor({ signals: [sig("correction", "no")], changed: [], checkCommand: null, preBytes })).toBeNull();
    expect(await gradersFor({ signals: [sig("loop", "x", "warn")], changed: [], checkCommand: "t", preBytes })).toBeNull();
    expect(await gradersFor({ signals: [sig("check-failed", "x")], changed: [], checkCommand: null, preBytes })).toBeNull();
  });
});

describe("captureCase", () => {
  const input = (over: Partial<Parameters<typeof captureCase>[1]> = {}) => ({
    projectId: "p",
    threadId: "t",
    userSeq: 3,
    prompt: "fix it, token: abcdefgh12345678",
    mode: "auto-edit" as const,
    agent: "fake",
    model: "fake-1",
    signals: [sig("check-failed", "npm test failed")],
    pre: pre({ "src/a.ts": "let a = 1;\n", "gone.txt": null }),
    changed: ["src/a.ts"],
    checkCommand: "npm test",
    preBytes: async () => null,
    now: () => 1000,
    ...over,
  });

  it("writes the pre-turn overlay, the graders and a redacted prompt", async () => {
    const root = tempDir();
    const c = await captureCase(root, input());
    expect(c).toMatchObject({ headSha: "abc123", deleted: ["gone.txt"], graderText: "the check command passes", mode: "auto-edit" });
    expect(c!.prompt).toBe("fix it, [secret]");
    expect(readFileSync(join(root, c!.id, "base", "src", "a.ts"), "utf8")).toBe("let a = 1;\n");
    expect(readCase(root, c!.id)).toEqual(c);
    expect(listCases(root).map((x) => x.id)).toEqual([c!.id]);
    expect(c!.heldOut).toBe(heldOutId(c!.id));
  });

  it("captures nothing when the tree can't be rebuilt, no grader applies, or a file looks secret", async () => {
    const root = tempDir();
    expect(await captureCase(root, input({ pre: pre({}, false) }))).toBeNull();
    expect(await captureCase(root, input({ pre: { ...pre({}), headSha: null } }))).toBeNull();
    expect(await captureCase(root, input({ signals: [sig("correction", "no")] }))).toBeNull();
    expect(await captureCase(root, input({ pre: pre({ ".env": "X=1" }) }))).toBeNull();
    expect(await captureCase(root, input({ pre: pre({ "cfg.ts": "const apiKey = 'sk-abcdefghijklmnopqrstuv'" }) }))).toBeNull();
    expect(listCases(root)).toEqual([]);
  });

  it("keeps only the newest cases", async () => {
    const root = tempDir();
    for (let i = 0; i < 32; i++) await captureCase(root, input({ userSeq: i, now: () => 1000 + i }));
    const all = listCases(root);
    expect(all).toHaveLength(30);
    expect(all[0]!.userSeq).toBe(31);
  });
});

function driver(id: string, models: ModelOption[], over: Partial<AgentDriver> = {}): AgentDriver {
  return { id, label: id, defaultModel: models[0]?.id ?? "", capabilities: SAFE_DEFAULTS, skillsDelivery: { mode: "none" }, skillCallPrefix: "", models: () => models, runTurn: async () => {}, ...over };
}
const m = (id: string, efforts?: string[]): ModelOption => ({ id, label: id, ...(efforts ? { efforts } : {}) });

describe("the background model", () => {
  const codex = driver("codex", [m("gpt-6"), m("gpt-6-luna", ["low", "high"])]);
  const claude = driver("claude", [m("opus"), m("haiku")]);
  const native = driver("provider-th", [m("deepseek-v4.1-flash")]);

  it("prefers the one picked in Settings, per project first", () => {
    const learn: LearnSettings = { ...LEARN_DEFAULTS, background: { agent: "claude", model: "haiku" }, backgroundByProject: { p: { agent: "codex", model: "gpt-6-luna" } } };
    expect(pickBackground({ learn, projectId: "p", drivers: [codex, claude, native] })).toMatchObject({ model: "gpt-6-luna", effort: "low", label: "codex · gpt-6-luna" });
    expect(pickBackground({ learn, projectId: "q", drivers: [codex, claude, native] })).toMatchObject({ model: "haiku" });
  });

  it("then a native provider's flash model, the thread agent's cheap tier, any cheap model", () => {
    expect(pickBackground({ learn: LEARN_DEFAULTS, projectId: "p", drivers: [codex, claude, native], thread: { agent: "claude", model: "opus" } })!.model).toBe("deepseek-v4.1-flash");
    expect(pickBackground({ learn: LEARN_DEFAULTS, projectId: "p", drivers: [codex, claude], thread: { agent: "claude", model: "opus" } })!.model).toBe("haiku");
    expect(pickBackground({ learn: LEARN_DEFAULTS, projectId: "p", drivers: [codex, claude], thread: null })!.model).toBe("gpt-6-luna");
    expect(pickBackground({ learn: LEARN_DEFAULTS, projectId: "p", drivers: [driver("x", [m("big")])] })).toBeNull();
  });

  it("runs a prompt with the driver's one-shot, else a denied plan-mode turn", async () => {
    const shot = driver("a", [m("a-mini")], { oneShot: async (r) => `echo:${r.model}:${r.effort}` });
    expect(await backgroundShot({ driver: shot, model: "a-mini", effort: "low", label: "" }, "12345678", new AbortController().signal)).toEqual({ text: "echo:a-mini:low", tokens: 2 + 4 });
    const seen: TurnInput[] = [];
    const turn = driver("b", [m("b-mini")], {
      runTurn: async (input) => {
        seen.push(input);
        expect(await input.requestPermission({ toolName: "Bash", summary: "rm", canAlwaysAllow: false })).toBe("deny");
        input.onEvent({ kind: "assistant-text", text: "{\"none\":true}" });
        input.onEvent({ kind: "turn-end", costUsd: null, inputTokens: 300, outputTokens: 20, durationMs: 1 });
      },
    });
    expect(await backgroundShot({ driver: turn, model: "b-mini", effort: null, label: "" }, "p", new AbortController().signal)).toEqual({ text: "{\"none\":true}", tokens: 320 });
    expect(seen[0]).toMatchObject({ permissionMode: "plan", tools: [], sessionId: null });
    expect(existsSync(seen[0]!.cwd)).toBe(false);
  });
});

/** A repo project, a service whose agent fails the check, and a learner drafting on a fake cheap model. */
function setupLearn(script: (input: TurnInput, n: number) => Promise<void>, reply: (prompt: string) => string | Promise<string>, opts: { now?: () => number; cap?: number } = {}) {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const dir = tempDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  let n = 0;
  const prompts: string[] = [];
  const main = driver("fake", [m("fake-1")], { runTurn: (input) => script(input, n++) });
  const cheap = driver("provider-cheap", [m("cheap-flash")], {
    oneShot: async (r) => {
      prompts.push(r.prompt);
      return reply(r.prompt);
    },
  });
  const updates: LiveUpdate[] = [];
  const service = new Service(store, () => catalog(), [main, cheap], (u) => updates.push(u));
  const project = store.addProject(dir);
  const settings: LearnSettings = { ...LEARN_DEFAULTS, enabledProjects: [project.id], ...(opts.cap ? { dailyTokens: opts.cap } : {}) };
  const db = new LearnDb(store.sql);
  const casesRoot = tempDir();
  const learner = createLearner({
    db,
    settings: () => settings,
    broadcast: (u) => updates.push(u),
    drivers: () => service.allDrivers(),
    busy: () => service.pendingState().running.length > 0,
    casesRoot: () => casesRoot,
    checkCommand: (pid) => store.getProject(pid).checkCommand ?? null,
    debounceMs: 5,
    log: () => {},
    ...(opts.now ? { now: opts.now } : {}),
  });
  closeAfter(() => learner.dispose());
  service.setLearner(learner);
  const thread = service.createThread(project.id, "fake");
  return { store, service, thread, db, learner, prompts, casesRoot, updates, project, dir };
}

const waitFor = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
};

/** A time whose case (thread, seq) isn't held out, so a lesson is drafted from it. */
function trainTime(threadId: string, userSeq: number): number {
  for (let t = 1_700_000_000_000; ; t++) {
    const id = createHash("sha256").update(`${threadId}\0${userSeq}\0${t}`).digest("hex").slice(0, 16);
    if (!heldOutId(id)) return t;
  }
}

const LESSON = JSON.stringify({ rule: "Run the project check before saying the work is done.", why: "The check failed after the turn.", paths: ["src"], keywords: ["fix"] });
const failing = async (input: TurnInput) => {
  writeFileSync(join(input.cwd, "src", "a.ts"), "export const a = 2;\n");
  input.onEvent({ kind: "assistant-text", text: "Done." });
};

describe("the learner drafts lessons from failed turns", () => {
  it("captures a case and drafts a candidate lesson on the cheap model, within budget", async () => {
    let t = 0;
    const env = setupLearn(failing, () => LESSON, { now: () => t });
    t = trainTime(env.thread.id, 1);
    env.store.setCheckCommand(env.project.id, `"${process.execPath}" -e "process.exit(3)"`, 0);
    await env.service.send({ threadId: env.thread.id, text: "fix a" });
    await waitFor(() => env.db.lessons(env.project.id).length > 0);
    const [lesson] = env.db.lessons(env.project.id);
    expect(lesson).toMatchObject({ status: "candidate", rule: "Run the project check before saying the work is done.", scope: { paths: ["src"], keywords: ["fix"] } });
    expect(lesson!.caseId).toBe(listCases(env.casesRoot)[0]!.id);
    expect(lesson!.provenance).toMatchObject({ threadId: env.thread.id, userSeq: 1, signals: ["check-failed"] });
    expect(env.prompts[0]).toContain("- check-failed (fail):");
    expect(env.db.spent(env.project.id, new Date(t).toISOString().slice(0, 10))).toBeGreaterThan(0);
    expect(env.updates.some((u) => u.type === "learn-changed")).toBe(true);
  });

  it("counts a failed turn as drafting until its lesson is drafted (the bench waits on it)", async () => {
    let t = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const env = setupLearn(failing, async () => (await gate, LESSON), { now: () => t });
    t = trainTime(env.thread.id, 1);
    env.store.setCheckCommand(env.project.id, `"${process.execPath}" -e "process.exit(3)"`, 0);
    expect(env.learner.overview(env.project.id).drafting).toBe(0);
    await env.service.send({ threadId: env.thread.id, text: "fix a" });
    await waitFor(() => env.learner.overview(env.project.id).drafting === 1);
    expect(env.learner.overview(env.project.id).drafting).toBe(1);
    expect(env.learner.overview("other").drafting).toBe(0);
    release();
    await waitFor(() => env.learner.overview(env.project.id).drafting === 0);
    expect(env.learner.overview(env.project.id).drafting).toBe(0);
    expect(env.db.lessons(env.project.id)).toHaveLength(1);
  });

  it("drafts nothing for a healthy turn, a turn that read the web, or once the budget is spent", async () => {
    const healthy = setupLearn(async (input) => input.onEvent({ kind: "assistant-text", text: "Hi" }), () => LESSON);
    await healthy.service.send({ threadId: healthy.thread.id, text: "hi" });
    const web = setupLearn(async (input) => {
      input.onEvent({ kind: "tool-use", toolUseId: "w", name: "WebFetch", summary: "x" });
      await failing(input);
    }, () => LESSON);
    web.store.setCheckCommand(web.project.id, `"${process.execPath}" -e "process.exit(3)"`, 0);
    await web.service.send({ threadId: web.thread.id, text: "fix a" });
    const broke = setupLearn(failing, () => LESSON, { cap: 1000 });
    broke.db.spend(broke.project.id, new Date().toISOString().slice(0, 10), 999);
    broke.store.setCheckCommand(broke.project.id, `"${process.execPath}" -e "process.exit(3)"`, 0);
    await broke.service.send({ threadId: broke.thread.id, text: "fix a" });
    await new Promise((r) => setTimeout(r, 200));
    for (const env of [healthy, web, broke]) expect(env.db.lessons(env.project.id)).toEqual([]);
    expect(healthy.prompts).toEqual([]);
    expect(web.prompts).toEqual([]);
    expect(broke.prompts).toEqual([]);
  });

  it("drafts a corrected turn with the next healthy answer as the contrast, and never twice", async () => {
    const env = setupLearn(async (input, n) => input.onEvent({ kind: "assistant-text", text: n === 0 ? "Renamed foo." : "Renamed bar as asked." }), () => LESSON);
    await env.service.send({ threadId: env.thread.id, text: "rename the helper" });
    await env.service.send({ threadId: env.thread.id, text: "No, I meant bar" });
    await waitFor(() => env.prompts.length > 0);
    expect(env.prompts[0]).toContain("A LATER TURN THAT WENT RIGHT:\nRenamed bar as asked.");
    expect(env.prompts[0]).toContain("- correction (fail):");
    await new Promise((r) => setTimeout(r, 100));
    expect(env.prompts).toHaveLength(1);
    // No case: a correction has no machine grader, so the lesson can't be verified yet.
    expect(env.db.lessons(env.project.id)[0]).toMatchObject({ caseId: null, status: "candidate" });
  });

  it("folds a duplicate lesson into the one already there", async () => {
    const env = setupLearn(async (input, n) => input.onEvent({ kind: "assistant-text", text: `answer ${n}` }), () => LESSON);
    for (const text of ["do x", "No, wrong", "do y", "No, wrong again", "ok"]) await env.service.send({ threadId: env.thread.id, text });
    await waitFor(() => env.prompts.length >= 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(env.db.lessons(env.project.id)).toHaveLength(1);
    expect(env.prompts[1]).toContain("EXISTING:\n- Run the project check before saying the work is done.");
  });
});
