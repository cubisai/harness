// Self-improving CubiQ (plan .ai/plans/self-improve.md): what the main
// process and the renderer share about turn scores and learned lessons.

/** Why a turn wasn't plainly healthy. */
export type SignalKind =
  | "evidence"
  | "check-failed"
  | "check-fixed"
  | "denied"
  | "stopped"
  | "correction"
  | "reverted"
  | "loop"
  | "over-norm";

export interface TurnSignal {
  kind: SignalKind;
  level: "warn" | "fail";
  /** One short line for the tooltip and the lesson prompt. */
  detail: string;
}

export type Health = "ok" | "warn" | "fail";

/** One user turn's score (its automatic fix rounds folded in), keyed by the user message's seq. */
export interface TurnScore {
  threadId: string;
  userSeq: number;
  health: Health;
  signals: TurnSignal[];
}

export type LessonStatus = "candidate" | "active" | "retired" | "dropped";

/** What the user can do to a lesson from the Learned tab. */
export type LessonAction = "retire" | "undo" | "pin" | "unpin" | "drop";

/** Where a lesson applies: paths (globs or prefixes) and prompt keywords; both empty = everywhere in the project. */
export interface LessonScope {
  paths: string[];
  keywords: string[];
}

/** One replay verdict: how many rollouts passed out of how many. */
export interface ReplayScore {
  passed: number;
  of: number;
}

export interface LessonVerification {
  model: string;
  agent: string;
  appVersion: string;
  at: number;
  before: ReplayScore;
  after: ReplayScore;
  /** Other cases replayed with the lesson: how many held their previous result. */
  transfer: { held: number; of: number };
}

export interface Lesson {
  id: string;
  projectId: string;
  rule: string;
  why: string;
  scope: LessonScope;
  status: LessonStatus;
  /** Real turns it was sent with that ended healthy / failed (ACE counters). */
  helpful: number;
  harmful: number;
  /** Real turns it was sent with. */
  relevant: number;
  /** Verification attempts so far. */
  tries: number;
  pinned: boolean;
  caseId: string | null;
  provenance: { threadId: string; userSeq: number; signals: SignalKind[]; agent: string; model: string };
  verified: LessonVerification | null;
  /** Why it was retired or dropped, or what's pending. */
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A captured eval case, as the Learned tab lists it. */
export interface LearnCase {
  id: string;
  createdAt: number;
  /** The grader in words ("check command passes"). */
  grader: string;
  heldOut: boolean;
  threadId: string;
  userSeq: number;
}

/** The Library's Learned tab for one project. */
export interface LearnOverview {
  enabled: boolean;
  /** The model background work runs on, as "Agent · model", or null when none can run. */
  background: { agent: string; model: string; label: string } | null;
  dailyTokens: number;
  usedToday: number;
  /** Oldest first: one entry per day with any scored turn, the last 14 days. */
  trend: { day: string; ok: number; warn: number; fail: number }[];
  lessons: Lesson[];
  cases: LearnCase[];
}

/** The project's self-improve settings; off unless the project is listed. */
export interface LearnSettings {
  enabledProjects: string[];
  /** Background tokens per project per day. */
  dailyTokens: number;
  /** Memory-extraction tokens per project per day; extraction pauses for the day past it. */
  memoryDailyTokens: number;
  /** The global background model; null = pick automatically. */
  background: { agent: string; model: string } | null;
  /** Per-project overrides of `background`. */
  backgroundByProject: Record<string, { agent: string; model: string }>;
}

/** Cheapest-first name hints for background models (without "free": a free tier can be the slowest). */
export const CHEAP_MODEL_HINTS = ["flash", "haiku", "mini", "nano", "lite", "luna", "small"];

export const LEARN_DEFAULTS: LearnSettings = { enabledProjects: [], dailyTokens: 50_000, memoryDailyTokens: 200_000, background: null, backgroundByProject: {} };

/** What a hidden background model call was for: shared memory extraction, or a lesson draft. */
export type BackgroundPurpose = "memory" | "lesson";

/** One background model call, as the accounting table records it. */
export interface BackgroundRun {
  purpose: BackgroundPurpose;
  projectId: string;
  /** "YYYY-MM-DD" the call is accounted to. */
  day: string;
  agent: string;
  model: string;
  tokens: number;
  /** True when the tokens are an estimate, not the driver's own count. */
  estimated: boolean;
  ok: boolean;
  /** The cheap pick failed and this was the fallback to the thread's own model. */
  escalated: boolean;
  at: number;
}
