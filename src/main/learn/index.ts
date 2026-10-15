// Self-improving CubiQ (plan .ai/plans/self-improve.md). The learner scores
// every turn of an opted-in project (S1, zero tokens). Off by default per
// project; every entry point is a no-op for a project that isn't opted in.

import type { Thread } from "../../shared/types";
import type { LiveUpdate } from "../../shared/types";
import { LEARN_DEFAULTS, type LearnSettings, type TurnScore, type TurnSignal } from "../../shared/learn";
import type { LearnDb, ScoreRow } from "./db";
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
  /** Snapshot the tree before a turn; null when off or outside git. */
  beforeTurn(t: { thread: Thread; cwd: string }): Promise<PreTurn | null>;
  /** The user sent a new message (not a fix round): a correction marks the turn before it. */
  onUserMessage(t: { thread: Thread; seq: number; text: string }): void;
  afterTurn(rec: TurnRecord, pre: PreTurn | null): Promise<void>;
  /** A thread's scores, for the health dots. */
  scores(threadId: string): TurnScore[];
  dispose(): void;
}

export interface LearnerDeps {
  db: LearnDb;
  settings: () => LearnSettings | undefined;
  broadcast: (u: LiveUpdate) => void;
  now?: () => number;
  /** How long after a turn its edits count as reverted when undone (default 10 min). */
  revertWindowMs?: number;
  log?: (msg: string) => void;
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

const view = (r: ScoreRow): TurnScore => ({ threadId: r.threadId, userSeq: r.userSeq, health: r.health, signals: r.signals });

export function createLearner(deps: LearnerDeps): Learner {
  const now = deps.now ?? (() => Date.now());
  const windowMs = deps.revertWindowMs ?? 10 * 60_000;
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const settings = (): LearnSettings => ({ ...LEARN_DEFAULTS, ...deps.settings() });
  const watches = new Map<string, Watch[]>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
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

  /** Mark watched turns whose edits are back to their pre-turn bytes; drop expired watches. */
  const checkReverts = (projectId: string): void => {
    const list = watches.get(projectId);
    if (!list?.length) return;
    const t = now();
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
        addSignals(w.threadId, w.userSeq, [{ kind: "reverted", level: "fail", detail: `Its edits were undone: ${names}` }]);
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
    list.push({ threadId: rec.thread.id, userSeq: rec.rootSeq, cwd: rec.cwd, paths: merged, until: now() + windowMs });
    watches.set(projectId, list);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) checkReverts(projectId);
    }, windowMs);
    timer.unref?.();
    timers.add(timer);
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
    } catch (err) {
      log(`learn: scoring failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    enabled,

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

    dispose() {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      watches.clear();
    },
  };
}
