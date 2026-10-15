// Typed access to self-improve's tables (created by db.ts migrations 23-26).

import type { DatabaseSync } from "node:sqlite";
import type { Health, Lesson, LessonScope, LessonStatus, LessonVerification, TurnScore, TurnSignal } from "../../shared/learn";

export interface ScoreRow extends TurnScore {
  projectId: string;
  agent: string;
  model: string;
  sessionId: string | null;
  /** Lesson ids sent with this turn. */
  injected: string[];
  steps: number;
  tokens: number;
  createdAt: number;
  updatedAt: number;
}

interface RawScore {
  thread_id: string;
  user_seq: number;
  project_id: string;
  agent: string;
  model: string;
  session_id: string | null;
  health: string;
  signals: string;
  injected: string;
  steps: number;
  tokens: number;
  created_at: number;
  updated_at: number;
}

interface RawLesson {
  id: string;
  project_id: string;
  rule: string;
  why: string;
  scope: string;
  status: string;
  helpful: number;
  harmful: number;
  relevant: number;
  tries: number;
  pinned: number;
  case_id: string | null;
  provenance: string;
  verified: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

function parse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function scoreOf(r: RawScore): ScoreRow {
  return {
    threadId: r.thread_id,
    userSeq: r.user_seq,
    projectId: r.project_id,
    agent: r.agent,
    model: r.model,
    sessionId: r.session_id,
    health: r.health as Health,
    signals: parse<TurnSignal[]>(r.signals, []),
    injected: parse<string[]>(r.injected, []),
    steps: r.steps,
    tokens: r.tokens,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function lessonOf(r: RawLesson): Lesson {
  return {
    id: r.id,
    projectId: r.project_id,
    rule: r.rule,
    why: r.why,
    scope: parse<LessonScope>(r.scope, { paths: [], keywords: [] }),
    status: r.status as LessonStatus,
    helpful: r.helpful,
    harmful: r.harmful,
    relevant: r.relevant,
    tries: r.tries,
    pinned: r.pinned === 1,
    caseId: r.case_id,
    provenance: parse<Lesson["provenance"]>(r.provenance, { threadId: "", userSeq: 0, signals: [], agent: "", model: "" }),
    verified: parse<LessonVerification | null>(r.verified, null),
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SCORE_COLS = "thread_id, user_seq, project_id, agent, model, session_id, health, signals, injected, steps, tokens, created_at, updated_at";

export class LearnDb {
  constructor(private db: DatabaseSync, private now: () => number = () => Date.now()) {}

  getScore(threadId: string, userSeq: number): ScoreRow | null {
    const r = this.db.prepare(`SELECT ${SCORE_COLS} FROM turn_scores WHERE thread_id = ? AND user_seq = ?`).get(threadId, userSeq) as unknown as RawScore | undefined;
    return r ? scoreOf(r) : null;
  }

  /** Insert or replace one turn's score; created_at survives a replace. */
  putScore(s: Omit<ScoreRow, "createdAt" | "updatedAt"> & { createdAt?: number }): ScoreRow {
    const now = this.now();
    const createdAt = this.getScore(s.threadId, s.userSeq)?.createdAt ?? s.createdAt ?? now;
    this.db
      .prepare(`INSERT OR REPLACE INTO turn_scores (${SCORE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.threadId, s.userSeq, s.projectId, s.agent, s.model, s.sessionId, s.health, JSON.stringify(s.signals), JSON.stringify(s.injected), s.steps, s.tokens, createdAt, now);
    return { ...s, createdAt, updatedAt: now };
  }

  threadScores(threadId: string): ScoreRow[] {
    return (this.db.prepare(`SELECT ${SCORE_COLS} FROM turn_scores WHERE thread_id = ? ORDER BY user_seq`).all(threadId) as unknown as RawScore[]).map(scoreOf);
  }

  /** The thread's newest score before `beforeSeq`. */
  lastScore(threadId: string, beforeSeq: number): ScoreRow | null {
    const r = this.db
      .prepare(`SELECT ${SCORE_COLS} FROM turn_scores WHERE thread_id = ? AND user_seq < ? ORDER BY user_seq DESC LIMIT 1`)
      .get(threadId, beforeSeq) as unknown as RawScore | undefined;
    return r ? scoreOf(r) : null;
  }

  projectScores(projectId: string, since: number): ScoreRow[] {
    return (
      this.db.prepare(`SELECT ${SCORE_COLS} FROM turn_scores WHERE project_id = ? AND created_at >= ? ORDER BY created_at`).all(projectId, since) as unknown as RawScore[]
    ).map(scoreOf);
  }

  /** The project's latest healthy turns' size, for the over-norm signal. */
  healthyNorms(projectId: string, limit = 30): { steps: number; tokens: number }[] {
    return this.db
      .prepare("SELECT steps, tokens FROM turn_scores WHERE project_id = ? AND health = 'ok' ORDER BY created_at DESC LIMIT ?")
      .all(projectId, limit) as unknown as { steps: number; tokens: number }[];
  }

  getLesson(id: string): Lesson | null {
    const r = this.db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as unknown as RawLesson | undefined;
    return r ? lessonOf(r) : null;
  }

  lessons(projectId: string, statuses?: LessonStatus[]): Lesson[] {
    const rows = this.db.prepare("SELECT * FROM lessons WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as unknown as RawLesson[];
    const all = rows.map(lessonOf);
    return statuses ? all.filter((l) => statuses.includes(l.status)) : all;
  }

  putLesson(l: Lesson): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO lessons (id, project_id, rule, why, scope, status, helpful, harmful, relevant, tries, pinned, case_id, provenance, verified, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        l.id,
        l.projectId,
        l.rule,
        l.why,
        JSON.stringify(l.scope),
        l.status,
        l.helpful,
        l.harmful,
        l.relevant,
        l.tries,
        l.pinned ? 1 : 0,
        l.caseId,
        JSON.stringify(l.provenance),
        l.verified ? JSON.stringify(l.verified) : null,
        l.note,
        l.createdAt,
        this.now(),
      );
  }

  /** Patch a lesson; returns the new row, or null when it's gone. */
  updateLesson(id: string, patch: Partial<Omit<Lesson, "id" | "projectId" | "createdAt" | "updatedAt">>): Lesson | null {
    const cur = this.getLesson(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.putLesson(next);
    return this.getLesson(id);
  }

  deleteLesson(id: string): void {
    this.db.prepare("DELETE FROM lessons WHERE id = ?").run(id);
  }

  cachedReplay(key: string): { pass: boolean; tokens: number } | null {
    const r = this.db.prepare("SELECT pass, tokens FROM learn_replays WHERE key = ?").get(key) as unknown as { pass: number; tokens: number } | undefined;
    return r ? { pass: r.pass === 1, tokens: r.tokens } : null;
  }

  saveReplay(key: string, caseId: string, lessonId: string | null, pass: boolean, tokens: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO learn_replays (key, case_id, lesson_id, pass, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key, caseId, lessonId, pass ? 1 : 0, tokens, this.now());
  }

  /** Background tokens the project spent on `day` ("YYYY-MM-DD"). */
  spent(projectId: string, day: string): number {
    const r = this.db.prepare("SELECT tokens FROM learn_budget WHERE project_id = ? AND day = ?").get(projectId, day) as unknown as { tokens: number } | undefined;
    return r?.tokens ?? 0;
  }

  spend(projectId: string, day: string, tokens: number): void {
    if (tokens <= 0) return;
    this.db
      .prepare("INSERT INTO learn_budget (project_id, day, tokens) VALUES (?, ?, ?) ON CONFLICT(project_id, day) DO UPDATE SET tokens = tokens + excluded.tokens")
      .run(projectId, day, Math.round(tokens));
  }
}
