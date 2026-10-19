// P8.4: the learner's lesson lifecycle wiring — the block sent with a turn,
// counting its outcome, the Learned tab's IPC methods and startup revalidation.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiveUpdate, ModelOption, Thread } from "../src/shared/types";
import type { AgentDriver } from "../src/main/agents/types";
import type { TurnRecord } from "../src/main/learn";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { LearnDb } from "../src/main/learn/db";
import { createLearner, type LearnerDeps } from "../src/main/learn";
import { LEARN_DEFAULTS, type LearnSettings, type Lesson, type LessonVerification } from "../src/shared/learn";
import { closeAfter, tempDir } from "./helpers";

const m = (id: string): ModelOption => ({ id, label: id });
const driver = (id: string, models: ModelOption[]): AgentDriver => ({
  id,
  label: id,
  defaultModel: models[0]?.id ?? "",
  capabilities: SAFE_DEFAULTS,
  skillsDelivery: { mode: "none" },
  skillCallPrefix: "",
  models: () => models,
  runTurn: async () => {},
});

const thread = (over: Partial<Thread> = {}): Thread =>
  ({ id: "t1", projectId: "p1", agent: "fake", model: "fake-1", sessionId: null, ...over }) as unknown as Thread;

const turn = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  thread: thread(),
  cwd: "/tmp",
  rootSeq: 1,
  round: 0,
  final: true,
  request: "do x",
  answer: "done",
  commands: [],
  failedCommands: [],
  toolNames: [],
  denied: 0,
  stopped: false,
  evidence: [],
  check: null,
  steps: 1,
  tokens: 10,
  changed: [],
  injected: [],
  ...over,
});

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: "a",
  projectId: "p1",
  rule: "Run the project check before saying the work is done.",
  why: "The check failed after the turn.",
  scope: { paths: [], keywords: [] },
  status: "active",
  helpful: 0,
  harmful: 0,
  relevant: 0,
  tries: 0,
  pinned: false,
  caseId: null,
  provenance: { threadId: "t1", userSeq: 1, signals: [], agent: "fake", model: "fake-1" },
  verified: null,
  note: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/** A real LearnDb on a temp Store, with fake deps and no background drivers by default. */
function setup(opts: { enabled?: boolean; drivers?: AgentDriver[]; verifyLesson?: LearnerDeps["verifyLesson"] } = {}) {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  // Scores reference threads; these tests drive the learner with ids ("p1", "t1") no project or thread row backs.
  store.sql.exec("PRAGMA foreign_keys = OFF");
  const db = new LearnDb(store.sql);
  const settings: LearnSettings = { ...LEARN_DEFAULTS, enabledProjects: opts.enabled === false ? [] : ["p1"] };
  const updates: LiveUpdate[] = [];
  const learner = createLearner({
    db,
    settings: () => settings,
    broadcast: (u) => updates.push(u),
    drivers: () => opts.drivers ?? [],
    busy: () => false,
    debounceMs: 60_000,
    log: () => {},
    ...(opts.verifyLesson ? { verifyLesson: opts.verifyLesson } : {}),
  });
  closeAfter(() => learner.dispose());
  return { db, learner, updates, settings };
}

const verification: LessonVerification = {
  model: "cheap-flash",
  agent: "provider-cheap",
  appVersion: "1.0",
  at: 5,
  before: { passed: 0, of: 1 },
  after: { passed: 1, of: 1 },
  transfer: { held: 1, of: 1 },
};

describe("lessonsBlockFor / injectedFor", () => {
  it("is null for a project that isn't opted in", () => {
    const off = setup({ enabled: false });
    off.db.putLesson(lesson());
    expect(off.learner.lessonsBlockFor("p1", "t1")).toBeNull();
    expect(off.learner.injectedFor("t1")).toEqual([]);
  });

  it("sends only active lessons and records what a thread was sent", () => {
    const { db, learner } = setup();
    db.putLesson(lesson({ id: "a", status: "active", rule: "Active rule." }));
    db.putLesson(lesson({ id: "b", status: "candidate", rule: "Candidate rule." }));
    db.putLesson(lesson({ id: "c", status: "retired", rule: "Retired rule." }));
    const block = learner.lessonsBlockFor("p1", "t1");
    expect(block).toBeTruthy();
    expect(learner.injectedFor("t1")).toEqual(["a"]);
    expect(learner.injectedFor("t2")).toEqual([]);
  });
});

describe("counting a turn's lessons", () => {
  it("bumps a lesson once per final turn: up when the turn passed, down when it failed", async () => {
    const { db, learner } = setup();
    db.putLesson(lesson({ id: "a", status: "active" }));
    db.putLesson(lesson({ id: "b", status: "candidate" }));
    await learner.afterTurn(turn({ rootSeq: 1, injected: ["a", "b"] }), null);
    expect(db.getLesson("a")).toMatchObject({ relevant: 1, helpful: 1, harmful: 0 });
    expect(db.getLesson("b")).toMatchObject({ relevant: 0, helpful: 0, harmful: 0 });
    await learner.afterTurn(turn({ rootSeq: 2, injected: ["a"], check: { command: "npm test", ok: false, tail: "" } }), null);
    expect(db.getLesson("a")).toMatchObject({ relevant: 2, helpful: 1, harmful: 1 });
  });

  it("retires a lesson no helpful turn has saved after three harmful ones", async () => {
    const { db, learner } = setup();
    db.putLesson(lesson({ id: "a", status: "active" }));
    const fail = (seq: number) => turn({ rootSeq: seq, injected: ["a"], check: { command: "npm test", ok: false, tail: "" } });
    await learner.afterTurn(fail(1), null);
    await learner.afterTurn(fail(2), null);
    expect(db.getLesson("a")).toMatchObject({ status: "active", harmful: 2 });
    await learner.afterTurn(fail(3), null);
    expect(db.getLesson("a")).toMatchObject({ status: "retired", harmful: 3, helpful: 0 });
  });

  it("counts nothing until the root turn is final", async () => {
    const { db, learner } = setup();
    db.putLesson(lesson({ id: "a", status: "active" }));
    await learner.afterTurn(turn({ rootSeq: 1, round: 0, final: false, injected: ["a"] }), null);
    expect(db.getLesson("a")).toMatchObject({ relevant: 0, helpful: 0, harmful: 0 });
    // The final round still counts what the root injected, once.
    await learner.afterTurn(turn({ rootSeq: 1, round: 1, final: true, injected: [] }), null);
    expect(db.getLesson("a")).toMatchObject({ relevant: 1, helpful: 1 });
  });
});

describe("the Learned tab's actions", () => {
  it("retires and undoes a lesson", () => {
    const { db, learner } = setup();
    db.putLesson(lesson({ id: "a", status: "active", verified: verification }));
    expect(learner.setLesson("a", "retire")).toMatchObject({ id: "a", status: "retired" });
    expect(learner.setLesson("a", "undo")).toMatchObject({ id: "a", status: "active" });
    // Undo never makes an unverified lesson active: it goes back to being a candidate.
    db.putLesson(lesson({ id: "u", status: "retired" }));
    expect(learner.setLesson("u", "undo")).toMatchObject({ id: "u", status: "candidate" });
    expect(learner.setLesson("nope", "retire")).toBeNull();
  });

  it("promotes a verified lesson and leaves a refused one a candidate with its why", async () => {
    const promote = setup({ verifyLesson: async () => ({ verification, promote: true, why: "both passed", tokens: 10 }) });
    promote.db.putLesson(lesson({ id: "a", status: "candidate" }));
    expect(await promote.learner.verify("a")).toMatchObject({ status: "active", tries: 1, verified: verification });
    expect(await promote.learner.verify("nope")).toBeNull();

    const refuse = setup({ verifyLesson: async () => ({ verification: null, promote: false, why: "transfer regressed", tokens: 10 }) });
    refuse.db.putLesson(lesson({ id: "b", status: "candidate" }));
    expect(await refuse.learner.verify("b")).toMatchObject({ status: "candidate", tries: 1, note: "transfer regressed", verified: null });
  });

  it("does nothing without a verifier", async () => {
    const { db, learner } = setup();
    db.putLesson(lesson({ id: "a", status: "candidate" }));
    expect(await learner.verify("a")).toBeNull();
  });

  it("demotes an active lesson verified on another runtime", () => {
    const { db, learner } = setup({ drivers: [driver("provider-cheap", [m("cheap-flash")])] });
    db.putLesson(lesson({ id: "a", status: "active", verified: { ...verification, model: "other-model", agent: "claude", appVersion: "0.1" } }));
    db.putLesson(lesson({ id: "b", status: "active", verified: verification }));
    expect(learner.revalidate(["p1"], "1.0")).toBe(1);
    expect(db.getLesson("a")).toMatchObject({ status: "candidate" });
    expect(db.getLesson("a")!.note).toContain("revalidate:");
    expect(db.getLesson("b")).toMatchObject({ status: "active" });
  });

  it("revalidates nothing when no background model can run", () => {
    const { db, learner } = setup();
    db.putLesson(lesson({ id: "a", status: "active", verified: { ...verification, model: "other-model" } }));
    expect(learner.revalidate(["p1"], "1.0")).toBe(0);
    expect(db.getLesson("a")).toMatchObject({ status: "active" });
  });
});

describe("overview", () => {
  it("reports the project's background, lessons and scored days", async () => {
    const { db, learner } = setup({ drivers: [driver("provider-cheap", [m("cheap-flash")])] });
    db.putLesson(lesson({ id: "a", status: "active" }));
    db.putLesson(lesson({ id: "b", status: "candidate" }));
    await learner.afterTurn(turn(), null);
    const o = learner.overview("p1");
    expect(o.enabled).toBe(true);
    expect(o.background).toMatchObject({ agent: "provider-cheap", model: "cheap-flash", label: "provider-cheap · cheap-flash" });
    expect(o.lessons.map((l) => l.id).sort()).toEqual(["a", "b"]);
    expect(o.dailyTokens).toBe(LEARN_DEFAULTS.dailyTokens);
    expect(o.cases).toEqual([]);
    expect(o.trend).toHaveLength(1);
    expect(o.trend[0]).toMatchObject({ ok: 1, warn: 0, fail: 0 });
  });
});
