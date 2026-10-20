// Self-improving CubiQ (plan .ai/plans/self-improve.md). The learner scores
// every turn of an opted-in project (S1, zero tokens); a failed turn is frozen
// as an eval case (S3) and drafted into a candidate lesson on the cheap
// background model (S2), idle-only and under the project's daily token cap.
// Off by default per project; every entry point is a no-op for a project that
// isn't opted in.

import { randomUUID } from "node:crypto";
import type { Thread } from "../../shared/types";
import type { LiveUpdate } from "../../shared/types";
import { LEARN_DEFAULTS, type LearnOverview, type LearnSettings, type Lesson, type LessonAction, type LessonVerification, type TurnScore, type TurnSignal } from "../../shared/learn";
import type { AgentDriver } from "../agents/types";
import { backgroundShot, estimateTokens, pickBackground } from "./background";
import { captureCase, caseView, listCases } from "./cases";
import type { LearnDb, ScoreRow } from "./db";
import { buildDraftPrompt, findDuplicate, parseLesson, pulledOutsideContent } from "./draft";
import { applyAction, autoRetire, countOutcome, lessonsBlock, relevantLessons, revalidation, type Runtime } from "./lifecycle";
import { healthOf, isCorrection, mergeSignals, roundSignals } from "./signals";
import { fileBytes, preBytes, sha256, snapshotPre, type PreTurn } from "./snapshot";

/** What one round of a turn did, handed over by the Service once the round (check and evidence gate included) is over. */
export interface TurnRecord {
  thread: Thread;
  cwd: string;
  /** The user message this turn answers (fix rounds keep their root's). */
  rootSeq: number;
  round: number;
  /** No automatic fix round follows this one. */
  final: boolean;
  request: string;
  answer: string;
  commands: string[];
  failedCommands: string[];
  /** Tool names the turn called (canonical or raw), for the poisoning filter. */
  toolNames: string[];
  denied: number;
  stopped: boolean;
  evidence: string[];
  check: { command: string; ok: boolean; tail: string } | null;
  steps: number;
  tokens: number;
  /** Project-relative paths the round changed. */
  changed: string[];
  /** Lesson ids sent with this round's prompt. */
  injected: string[];
}

export interface Learner {
  /** Whether self-improve is on for this project. */
  enabled(projectId: string): boolean;
  /** The active lessons' prompt block for a turn, remembering the ids a thread was sent; null when off. */
  lessonsBlockFor(projectId: string, threadId?: string): string | null;
  /** The lesson ids last sent to a thread. */
  injectedFor(threadId: string): string[];
  /** Snapshot the tree before a turn; null when off or outside git. */
  beforeTurn(t: { thread: Thread; cwd: string }): Promise<PreTurn | null>;
  /** The user sent a new message (not a fix round): a correction marks the turn before it. */
  onUserMessage(t: { thread: Thread; seq: number; text: string }): void;
  afterTurn(rec: TurnRecord, pre: PreTurn | null): Promise<void>;
  /** A thread's scores, for the health dots. */
  scores(threadId: string): TurnScore[];
  /** The Learned tab's data for one project. */
  overview(projectId: string): LearnOverview;
  /** Apply a Learned-tab action to a lesson; null when it doesn't apply. */
  setLesson(id: string, action: LessonAction): Lesson | null;
  /** Replay the lesson's case and promote or leave it; null without a verifier or lesson. */
  verify(id: string): Promise<Lesson | null>;
  /** Demote active lessons whose verification no longer holds; how many moved. */
  revalidate(projectIds: string[], appVersion: string): number;
  dispose(): void;
}

export interface LearnerDeps {
  db: LearnDb;
  settings: () => LearnSettings | undefined;
  broadcast: (u: LiveUpdate) => void;
  /** The agents background work can run on. */
  drivers?: () => AgentDriver[];
  /** True while any thread's turn runs: background work waits. */
  busy?: () => boolean;
  /** Where a project's captured cases live. */
  casesRoot?: (projectId: string) => string;
  /** The project's check command, for a failed-check grader. */
  checkCommand?: (projectId: string) => string | null;
  /** One-line notes the project already keeps (memory), so a lesson doesn't repeat one. */
  existing?: (projectId: string) => string[];
  /** The project's tracked file names at `cwd` (names only), for the drafter; absent = none. */
  projectFiles?: (cwd: string) => string[];
  /** Replay a lesson's case and report the verdict (S3); absent = verification is off. */
  verifyLesson?: (l: Lesson) => Promise<{ verification: LessonVerification | null; promote: boolean; why: string; tokens: number } | null>;
  now?: () => number;
  /** How long after a turn its edits count as reverted when undone (default 10 min). */
  revertWindowMs?: number;
  /** How long a failed turn waits before it's drafted (default 30 s): a correction or revert may still come. */
  debounceMs?: number;
  log?: (msg: string) => void;
}

/** A finished turn kept for drafting: its record (fix rounds merged) and the tree before it. */
interface Recent {
  rec: TurnRecord;
  pre: PreTurn | null;
}

interface DraftJob {
  key: string;
  projectId: string;
  contrast: string | null;
  caseId: string | null;
}

interface Watch {
  threadId: string;
  userSeq: number;
  cwd: string;
  paths: { rel: string; pre: string | null; post: string | null }[];
  until: number;
}

/** At most this many changed paths are watched for a revert per turn. */
const WATCH_PATHS = 20;
/** Finished turns kept for drafting, and how many of them keep their pre-turn tree. */
const RECENT_TURNS = 30;
const RECENT_TREES = 5;
const DRAFT_TIMEOUT_MS = 120_000;
/** Days the Learned tab's trend covers, and one day's milliseconds. */
const TREND_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const keyOf = (threadId: string, userSeq: number): string => `${threadId}:${userSeq}`;
export const today = (t: number): string => new Date(t).toISOString().slice(0, 10);

const view = (r: ScoreRow): TurnScore => ({ threadId: r.threadId, userSeq: r.userSeq, health: r.health, signals: r.signals });

export function createLearner(deps: LearnerDeps): Learner {
  const now = deps.now ?? (() => Date.now());
  const windowMs = deps.revertWindowMs ?? 10 * 60_000;
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const settings = (): LearnSettings => ({ ...LEARN_DEFAULTS, ...deps.settings() });
  const watches = new Map<string, Watch[]>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const recent = new Map<string, Recent>();
  /** The lesson ids last sent to each thread, so a turn knows what to count. */
  const injectedByThread = new Map<string, string[]>();
  /** Turns already sent to the drafter (one lesson attempt per turn). */
  const learned = new Set<string>();
  /** A corrected turn waits for the thread's next turn, whose answer (when healthy) is the contrast. */
  const awaitingContrast = new Map<string, string>();
  const jobs: DraftJob[] = [];
  let jobTimer: ReturnType<typeof setTimeout> | null = null;
  let working = false;
  const controller = new AbortController();
  let disposed = false;
  const debounceMs = deps.debounceMs ?? 30_000;

  const later = (ms: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) fn();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  };

  const learnChanged = (projectId: string) => deps.broadcast({ type: "learn-changed", projectId });

  /** Background tokens the project may still spend today. */
  const budgetLeft = (projectId: string): number => settings().dailyTokens - deps.db.spent(projectId, today(now()));

  const remember = (rec: TurnRecord, pre: PreTurn | null): void => {
    const key = keyOf(rec.thread.id, rec.rootSeq);
    const prior = recent.get(key);
    // A fix round keeps its root's request and pre-turn tree; the rest is the latest round's, with commands and changes added up.
    const merged: Recent = prior
      ? {
          rec: {
            ...rec,
            request: prior.rec.request,
            commands: [...prior.rec.commands, ...rec.commands],
            failedCommands: [...prior.rec.failedCommands, ...rec.failedCommands],
            toolNames: [...prior.rec.toolNames, ...rec.toolNames],
            changed: [...new Set([...prior.rec.changed, ...rec.changed])],
            evidence: [...new Set([...prior.rec.evidence, ...rec.evidence])],
          },
          pre: prior.pre,
        }
      : { rec, pre };
    recent.delete(key);
    recent.set(key, merged);
    const keys = [...recent.keys()];
    for (const k of keys.slice(0, Math.max(0, keys.length - RECENT_TURNS))) recent.delete(k);
    for (const k of keys.slice(0, Math.max(0, keys.length - RECENT_TREES))) {
      const r = recent.get(k);
      if (r?.pre) recent.set(k, { ...r, pre: null });
    }
  };

  /** A failed turn: freeze it as a case (when a grader applies) and queue its lesson draft. Never rejects. */
  const learn = (key: string, contrast: string | null, reverted?: string[]): Promise<void> =>
    capture(key, contrast, reverted).catch((err) => log(`learn: capture failed (${key}): ${err instanceof Error ? err.message : String(err)}`));

  const capture = async (key: string, contrast: string | null, reverted?: string[]): Promise<void> => {
    if (disposed) return;
    const info = recent.get(key);
    if (!info || learned.has(key)) return;
    const { rec, pre } = info;
    const projectId = rec.thread.projectId;
    if (!enabled(projectId)) return;
    const row = deps.db.getScore(rec.thread.id, rec.rootSeq);
    if (!row || row.health !== "fail") return;
    learned.add(key);
    // Content from outside the repo (web, MCP, the browser) can carry instructions: never learn from it.
    if (pulledOutsideContent(rec.toolNames)) {
      log(`learn: skipped ${key}: the turn pulled web or MCP content`);
      return;
    }
    let caseId: string | null = null;
    if (pre && deps.casesRoot) {
      const c = await captureCase(deps.casesRoot(projectId), {
        projectId,
        threadId: rec.thread.id,
        userSeq: rec.rootSeq,
        prompt: rec.request,
        mode: rec.thread.permissionMode,
        agent: rec.thread.agent,
        model: rec.thread.model,
        signals: row.signals,
        pre,
        changed: rec.changed,
        checkCommand: deps.checkCommand?.(projectId) ?? null,
        ...(reverted ? { reverted } : {}),
        preBytes: (rel) => preBytes(rec.cwd, pre, rel),
        now,
      });
      if (c) {
        learnChanged(projectId);
        // A held-out case only ever checks other lessons for regressions; nothing is drafted from it.
        if (c.heldOut) return;
        caseId = c.id;
      }
    }
    jobs.push({ key, projectId, contrast, caseId });
    schedule(debounceMs);
  };

  const schedule = (ms: number): void => {
    if (jobTimer || disposed) return;
    jobTimer = setTimeout(() => {
      jobTimer = null;
      void runJobs();
    }, ms);
    jobTimer.unref?.();
  };

  /** Drain the draft queue one job at a time, never while a turn runs. */
  const runJobs = async (): Promise<void> => {
    if (working || disposed) return;
    if (deps.busy?.()) return schedule(debounceMs);
    const job = jobs.shift();
    if (!job) return;
    working = true;
    try {
      await draft(job);
    } catch (err) {
      log(`learn: draft failed (${job.key}): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      working = false;
      if (jobs.length) schedule(1000);
    }
  };

  const draft = async (job: DraftJob): Promise<void> => {
    const info = recent.get(job.key);
    if (!info || !enabled(job.projectId)) return;
    const { rec } = info;
    const row = deps.db.getScore(rec.thread.id, rec.rootSeq);
    if (!row) return;
    const bg = pickBackground({ learn: settings(), projectId: job.projectId, drivers: deps.drivers?.() ?? [], thread: { agent: rec.thread.agent, model: rec.thread.model } });
    if (!bg) return log(`learn: no background model can run for ${job.projectId}`);
    const lessons = deps.db.lessons(job.projectId).filter((l) => l.status !== "dropped");
    const prompt = buildDraftPrompt({
      request: rec.request,
      answer: rec.answer,
      signals: row.signals,
      commands: rec.commands,
      checkTail: rec.check && !rec.check.ok ? rec.check.tail : null,
      changed: rec.changed,
      files: deps.projectFiles?.(rec.cwd) ?? [],
      contrast: job.contrast,
      existing: [...lessons.map((l) => l.rule), ...(deps.existing?.(job.projectId) ?? [])].slice(0, 40),
    });
    if (estimateTokens(prompt) * 2 > budgetLeft(job.projectId)) return log(`learn: daily budget spent for ${job.projectId}`);
    const timeout = AbortSignal.timeout(DRAFT_TIMEOUT_MS);
    const { text, tokens } = await backgroundShot(bg, prompt, AbortSignal.any([controller.signal, timeout]));
    deps.db.spend(job.projectId, today(now()), tokens);
    deps.db.recordRun({
      purpose: "lesson",
      projectId: job.projectId,
      day: today(now()),
      agent: bg.driver.id,
      model: bg.model,
      tokens,
      estimated: true,
      ok: true,
      escalated: false,
      at: now(),
    });
    const drafted = parseLesson(text);
    if (!drafted) return;
    const dup = findDuplicate(drafted.rule, lessons);
    if (dup) {
      // The same lesson again: it gains this turn's case when it had none, never a second copy.
      const existing = lessons.find((l) => l.id === dup)!;
      if (!existing.caseId && job.caseId) deps.db.updateLesson(dup, { caseId: job.caseId });
      learnChanged(job.projectId);
      return;
    }
    const t = now();
    const lesson: Lesson = {
      id: randomUUID(),
      projectId: job.projectId,
      rule: drafted.rule,
      why: drafted.why,
      scope: drafted.scope,
      status: "candidate",
      helpful: 0,
      harmful: 0,
      relevant: 0,
      tries: 0,
      pinned: false,
      caseId: job.caseId,
      provenance: { threadId: rec.thread.id, userSeq: rec.rootSeq, signals: row.signals.map((s) => s.kind), agent: rec.thread.agent, model: rec.thread.model },
      verified: null,
      note: job.caseId ? "Waiting to be verified by a replay." : "No case to verify it against: stays a candidate.",
      createdAt: t,
      updatedAt: t,
    };
    deps.db.putLesson(lesson);
    log(`learn: drafted a candidate lesson for ${job.projectId} on ${bg.label}`);
    learnChanged(job.projectId);
  };
  let chain: Promise<void> = Promise.resolve();

  const enabled = (projectId: string): boolean => !disposed && settings().enabledProjects.includes(projectId);

  /** Add signals to an existing score and tell the renderer. */
  const addSignals = (threadId: string, userSeq: number, add: TurnSignal[]): void => {
    const cur = deps.db.getScore(threadId, userSeq);
    if (!cur) return;
    const signals = mergeSignals(cur.signals, add);
    const row = deps.db.putScore({ ...cur, signals, health: healthOf(signals) });
    deps.broadcast({ type: "turn-score", score: view(row) });
  };

  /** Hold a corrected turn's draft for the next turn's contrast; draft it anyway after 3 minutes. */
  const awaitContrast = (threadId: string, key: string): void => {
    awaitingContrast.set(threadId, key);
    later(3 * 60_000, () => {
      if (awaitingContrast.get(threadId) !== key) return;
      awaitingContrast.delete(threadId);
      void learn(key, null);
    });
  };

  /**
   * Mark watched turns whose edits are back to their pre-turn bytes; drop expired watches.
   * `asOf` lets a window's own deadline timer look at the files as of its last moment: that timer
   * fires at the deadline, when `now()` alone would already count the watch as expired.
   */
  const checkReverts = (projectId: string, asOf?: number): void => {
    const list = watches.get(projectId);
    if (!list?.length) return;
    const t = asOf ?? now();
    const keep: Watch[] = [];
    for (const w of list) {
      // Past its window, an undo is the user's own later change, not a revert.
      if (w.until <= t) continue;
      const reverted = w.paths.filter((p) => {
        const bytes = fileBytes(w.cwd, p.rel);
        if (bytes === "too-big") return false;
        const current = bytes ? sha256(bytes) : null;
        return current === p.pre && current !== p.post;
      });
      if (reverted.length) {
        const names = reverted.map((p) => p.rel).slice(0, 3).join(", ");
        addSignals(w.threadId, w.userSeq, [{ kind: "reverted", level: "fail", detail: `The user restored these files to how they were before the turn: ${names}` }]);
        void learn(keyOf(w.threadId, w.userSeq), null, reverted.map((p) => p.rel));
        continue;
      }
      keep.push(w);
    }
    if (keep.length) watches.set(projectId, keep);
    else watches.delete(projectId);
  };

  const watch = async (rec: TurnRecord, pre: PreTurn): Promise<void> => {
    const paths: Watch["paths"] = [];
    for (const rel of rec.changed.slice(0, WATCH_PATHS)) {
      const after = fileBytes(rec.cwd, rel);
      if (after === "too-big") continue;
      const before = await preBytes(rec.cwd, pre, rel);
      const preSha = before ? sha256(before) : null;
      const postSha = after ? sha256(after) : null;
      if (preSha !== postSha) paths.push({ rel, pre: preSha, post: postSha });
    }
    if (!paths.length) return;
    const projectId = rec.thread.projectId;
    const same = (w: Watch) => w.threadId === rec.thread.id && w.userSeq === rec.rootSeq;
    // A fix round folds into its root turn's watch: the root's pre-turn bytes, this round's post-turn ones.
    const prior = watches.get(projectId)?.find(same);
    const merged = prior
      ? [...prior.paths.filter((p) => !paths.some((q) => q.rel === p.rel)), ...paths.map((p) => ({ ...p, pre: prior.paths.find((q) => q.rel === p.rel)?.pre ?? p.pre }))]
      : paths;
    const list = (watches.get(projectId) ?? []).filter((w) => !same(w));
    const until = now() + windowMs;
    list.push({ threadId: rec.thread.id, userSeq: rec.rootSeq, cwd: rec.cwd, paths: merged, until });
    watches.set(projectId, list);
    later(windowMs, () => checkReverts(projectId, until - 1));
  };

  const score = async (rec: TurnRecord, pre: PreTurn | null): Promise<void> => {
    if (!enabled(rec.thread.projectId)) return;
    try {
      const prev = deps.db.getScore(rec.thread.id, rec.rootSeq);
      const next = roundSignals(
        {
          evidence: rec.evidence,
          check: rec.check ? { ok: rec.check.ok, command: rec.check.command } : null,
          fixRound: rec.round > 0,
          denied: rec.denied,
          stopped: rec.stopped,
          failedCommands: rec.failedCommands,
          steps: (prev?.steps ?? 0) + rec.steps,
          tokens: (prev?.tokens ?? 0) + rec.tokens,
        },
        prev ? [] : deps.db.healthyNorms(rec.thread.projectId),
      );
      const signals = prev ? mergeSignals(prev.signals, next) : next;
      const row = deps.db.putScore({
        threadId: rec.thread.id,
        userSeq: rec.rootSeq,
        projectId: rec.thread.projectId,
        agent: rec.thread.agent,
        model: rec.thread.model,
        sessionId: rec.thread.sessionId,
        health: healthOf(signals),
        signals,
        injected: [...new Set([...(prev?.injected ?? []), ...rec.injected])],
        steps: (prev?.steps ?? 0) + rec.steps,
        tokens: (prev?.tokens ?? 0) + rec.tokens,
      });
      deps.broadcast({ type: "turn-score", score: view(row) });
      if (pre && rec.changed.length) await watch(rec, pre);
      remember(rec, pre);
      if (rec.final) {
        // This turn answers a correction: its answer, when it went well, shows what was wanted.
        const corrected = awaitingContrast.get(rec.thread.id);
        if (corrected && corrected !== keyOf(rec.thread.id, rec.rootSeq)) {
          awaitingContrast.delete(rec.thread.id);
          await learn(corrected, row.health === "ok" ? rec.answer : null);
        }
        // A turn that failed on its own (a correction or revert can still arrive and add a contrast first).
        if (row.health === "fail") await learn(keyOf(rec.thread.id, rec.rootSeq), null);
        // Lessons that rode this turn: count it once, at the root turn's end.
        let changed = false;
        for (const id of new Set(row.injected)) {
          const l = deps.db.getLesson(id);
          if (!l || l.status !== "active") continue;
          const patch = countOutcome(l, row.health);
          const retire = autoRetire({ ...l, ...patch });
          deps.db.updateLesson(id, { ...patch, ...(retire ?? {}) });
          changed = true;
        }
        if (changed) learnChanged(rec.thread.projectId);
      }
    } catch (err) {
      log(`learn: scoring failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    enabled,

    lessonsBlockFor(projectId, threadId) {
      try {
        if (!enabled(projectId)) return null;
        const lessons = relevantLessons(deps.db.lessons(projectId, ["active"]));
        if (threadId) injectedByThread.set(threadId, lessons.map((l) => l.id));
        return lessonsBlock(lessons);
      } catch {
        return null;
      }
    },

    injectedFor(threadId) {
      return injectedByThread.get(threadId) ?? [];
    },

    async beforeTurn({ thread, cwd }) {
      if (!enabled(thread.projectId)) return null;
      return snapshotPre(cwd, now);
    },

    onUserMessage({ thread, seq, text }) {
      if (!enabled(thread.projectId)) return;
      try {
        checkReverts(thread.projectId);
        if (!isCorrection(text)) return;
        const last = deps.db.lastScore(thread.id, seq);
        if (!last || last.signals.some((s) => s.kind === "correction")) return;
        const line = text.trim().split("\n")[0] ?? "";
        addSignals(thread.id, last.userSeq, [{ kind: "correction", level: "fail", detail: `You corrected it: "${line.length > 80 ? `${line.slice(0, 79)}…` : line}"` }]);
        awaitContrast(thread.id, keyOf(thread.id, last.userSeq));
      } catch (err) {
        log(`learn: correction check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    afterTurn(rec, pre) {
      // One at a time, in order: a fix round folds into the score its root turn wrote.
      chain = chain.then(() => score(rec, pre)).catch(() => {});
      return chain;
    },

    scores(threadId) {
      try {
        return deps.db.threadScores(threadId).map(view);
      } catch {
        return [];
      }
    },

    overview(projectId) {
      const s = settings();
      const bg = pickBackground({ learn: s, projectId, drivers: deps.drivers?.() ?? [] });
      const byDay = new Map<string, { day: string; ok: number; warn: number; fail: number }>();
      for (const row of deps.db.projectScores(projectId, now() - TREND_DAYS * DAY_MS)) {
        const day = today(row.createdAt);
        const entry = byDay.get(day) ?? { day, ok: 0, warn: 0, fail: 0 };
        entry[row.health]++;
        byDay.set(day, entry);
      }
      return {
        enabled: enabled(projectId),
        background: bg ? { agent: bg.driver.id, model: bg.model, label: bg.label } : null,
        dailyTokens: s.dailyTokens,
        usedToday: deps.db.spent(projectId, today(now())),
        trend: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
        lessons: deps.db.lessons(projectId),
        cases: deps.casesRoot ? listCases(deps.casesRoot(projectId)).map(caseView) : [],
      };
    },

    setLesson(id, action) {
      const lesson = deps.db.getLesson(id);
      if (!lesson) return null;
      const patch = applyAction(lesson, action);
      if (!patch) return null;
      const updated = deps.db.updateLesson(id, patch);
      learnChanged(lesson.projectId);
      return updated;
    },

    async verify(id) {
      const verifyLesson = deps.verifyLesson;
      if (!verifyLesson) return null;
      const lesson = deps.db.getLesson(id);
      if (!lesson) return null;
      const result = await verifyLesson(lesson);
      if (!result) return null;
      const updated = deps.db.updateLesson(id, {
        tries: lesson.tries + 1,
        verified: result.verification ?? lesson.verified,
        status: result.promote ? "active" : lesson.status,
        note: result.promote ? null : result.why,
      });
      learnChanged(lesson.projectId);
      return updated;
    },

    revalidate(projectIds, appVersion) {
      let moved = 0;
      for (const projectId of projectIds) {
        const bg = pickBackground({ learn: settings(), projectId, drivers: deps.drivers?.() ?? [] });
        if (!bg) continue;
        const rt: Runtime = { model: bg.model, agent: bg.driver.id, appVersion };
        let changed = false;
        for (const lesson of deps.db.lessons(projectId, ["active"])) {
          const reason = revalidation(lesson, rt);
          if (reason === null) continue;
          deps.db.updateLesson(lesson.id, { status: "candidate", note: `revalidate: ${reason}` });
          moved++;
          changed = true;
        }
        if (changed) learnChanged(projectId);
      }
      return moved;
    },

    dispose() {
      disposed = true;
      controller.abort();
      if (jobTimer) clearTimeout(jobTimer);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      watches.clear();
    },
  };
}
