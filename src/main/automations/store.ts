// Typed access to scheduled automations' tables (created by db.ts migration 29).

import type { DatabaseSync } from "node:sqlite";
import type { MissedPolicy, RunStatus, Schedule } from "../../shared/automations";

export interface Automation {
  id: string;
  projectId: string;
  name: string;
  template: string;
  prompt: string;
  schedule: Schedule;
  missed: MissedPolicy;
  enabled: boolean;
  agent: string | null;
  model: string | null;
  budgetUsd: number | null;
  configVersion: number;
  anchor: number;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRun {
  id: number;
  automationId: string;
  runKey: string;
  scheduledAt: number;
  status: RunStatus;
  threadId: string | null;
  leaseUntil: number | null;
  configVersion: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: number | null;
  endedAt: number | null;
  checkpoint: unknown;
  result: string | null;
  error: string | null;
  createdAt: number;
}

export type CursorStatus = "ok" | "unavailable" | "never";

/** A per-source read cursor: the bookmark only ever advances on confirmed progress. */
export interface SourceCursor {
  automationId: string;
  source: string;
  bookmark: string | null;
  lastOkAt: number | null;
  lastStatus: CursorStatus;
  lastError: string | null;
  updatedAt: number;
}

export type DeliveryState = "intent" | "published" | "confirmed" | "unknown";

/** A delivery's idempotency record, replayed at most once per destination. */
export interface Delivery {
  idempotencyKey: string;
  runId: number;
  destination: string;
  state: DeliveryState;
  receipt: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawAutomation {
  id: string;
  project_id: string;
  name: string;
  template: string;
  prompt: string;
  schedule: string;
  missed: string;
  enabled: number;
  agent: string | null;
  model: string | null;
  budget_usd: number | null;
  config_version: number;
  anchor: number;
  created_at: number;
  updated_at: number;
}

interface RawRun {
  id: number;
  automation_id: string;
  run_key: string;
  scheduled_at: number;
  status: string;
  thread_id: string | null;
  lease_until: number | null;
  config_version: number;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  started_at: number | null;
  ended_at: number | null;
  checkpoint: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
}

interface RawCursor {
  automation_id: string;
  source: string;
  bookmark: string | null;
  last_ok_at: number | null;
  last_status: string;
  last_error: string | null;
  updated_at: number;
}

interface RawDelivery {
  idempotency_key: string;
  run_id: number;
  destination: string;
  state: string;
  receipt: string | null;
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

function automationOf(r: RawAutomation): Automation {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    template: r.template,
    prompt: r.prompt,
    schedule: parse<Schedule>(r.schedule, { kind: "interval", everyMinutes: 0 }),
    missed: r.missed as MissedPolicy,
    enabled: r.enabled === 1,
    agent: r.agent,
    model: r.model,
    budgetUsd: r.budget_usd,
    configVersion: r.config_version,
    anchor: r.anchor,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function runOf(r: RawRun): AutomationRun {
  return {
    id: r.id,
    automationId: r.automation_id,
    runKey: r.run_key,
    scheduledAt: r.scheduled_at,
    status: r.status as RunStatus,
    threadId: r.thread_id,
    leaseUntil: r.lease_until,
    configVersion: r.config_version,
    costUsd: r.cost_usd,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    checkpoint: parse<unknown>(r.checkpoint, null),
    result: r.result,
    error: r.error,
    createdAt: r.created_at,
  };
}

function cursorOf(r: RawCursor): SourceCursor {
  return {
    automationId: r.automation_id,
    source: r.source,
    bookmark: r.bookmark,
    lastOkAt: r.last_ok_at,
    lastStatus: r.last_status as CursorStatus,
    lastError: r.last_error,
    updatedAt: r.updated_at,
  };
}

function deliveryOf(r: RawDelivery): Delivery {
  return {
    idempotencyKey: r.idempotency_key,
    runId: r.run_id,
    destination: r.destination,
    state: r.state as DeliveryState,
    receipt: r.receipt,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const AUTO_COLS = "id, project_id, name, template, prompt, schedule, missed, enabled, agent, model, budget_usd, config_version, anchor, created_at, updated_at";
const RUN_COLS =
  "id, automation_id, run_key, scheduled_at, status, thread_id, lease_until, config_version, cost_usd, input_tokens, output_tokens, started_at, ended_at, checkpoint, result, error, created_at";
const CUR_COLS = "automation_id, source, bookmark, last_ok_at, last_status, last_error, updated_at";
const DEL_COLS = "idempotency_key, run_id, destination, state, receipt, created_at, updated_at";

/** One run per scheduled instant, guarded by run_key; cursors and deliveries reconcile on restart. */
export class AutomationStore {
  constructor(private db: DatabaseSync, private now: () => number = () => Date.now()) {}

  create(a: Omit<Automation, "createdAt" | "updatedAt" | "configVersion">): Automation {
    const now = this.now();
    this.db
      .prepare(`INSERT INTO automations (${AUTO_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.projectId, a.name, a.template, a.prompt, JSON.stringify(a.schedule), a.missed, a.enabled ? 1 : 0, a.agent, a.model, a.budgetUsd, 1, a.anchor, now, now);
    return this.get(a.id)!;
  }

  get(id: string): Automation | null {
    const r = this.db.prepare(`SELECT ${AUTO_COLS} FROM automations WHERE id = ?`).get(id) as unknown as RawAutomation | undefined;
    return r ? automationOf(r) : null;
  }

  list(projectId?: string): Automation[] {
    const rows = projectId
      ? (this.db.prepare(`SELECT ${AUTO_COLS} FROM automations WHERE project_id = ? ORDER BY created_at, id`).all(projectId) as unknown as RawAutomation[])
      : (this.db.prepare(`SELECT ${AUTO_COLS} FROM automations ORDER BY created_at, id`).all() as unknown as RawAutomation[]);
    return rows.map(automationOf);
  }

  /** Patch an automation; any edit bumps configVersion, so a stale run never inherits new settings. */
  update(id: string, patch: Partial<Pick<Automation, "name" | "prompt" | "schedule" | "missed" | "enabled" | "agent" | "model" | "budgetUsd">>): Automation {
    const cur = this.get(id);
    if (!cur) throw new Error(`automation not found: ${id}`);
    const next: Automation = { ...cur, ...patch, configVersion: cur.configVersion + 1, updatedAt: this.now() };
    this.db
      .prepare("UPDATE automations SET name = ?, prompt = ?, schedule = ?, missed = ?, enabled = ?, agent = ?, model = ?, budget_usd = ?, config_version = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.prompt, JSON.stringify(next.schedule), next.missed, next.enabled ? 1 : 0, next.agent, next.model, next.budgetUsd, next.configVersion, next.updatedAt, id);
    return next;
  }

  /** Delete the automation and everything it owns, all or nothing. */
  remove(id: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM automation_deliveries WHERE run_id IN (SELECT id FROM automation_runs WHERE automation_id = ?)").run(id);
      this.db.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(id);
      this.db.prepare("DELETE FROM automation_cursors WHERE automation_id = ?").run(id);
      this.db.prepare("DELETE FROM automations WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Claim the run for one scheduled instant, or null if it was already claimed.
   * run_key is unique, so a restart or wake re-claiming the same instant is a no-op.
   */
  claimRun(automationId: string, runKey: string, scheduledAt: number): AutomationRun | null {
    const a = this.get(automationId);
    if (!a) throw new Error(`automation not found: ${automationId}`);
    const info = this.db
      .prepare("INSERT OR IGNORE INTO automation_runs (automation_id, run_key, scheduled_at, status, config_version, created_at) VALUES (?, ?, ?, 'queued', ?, ?)")
      .run(automationId, runKey, scheduledAt, a.configVersion, this.now());
    return Number(info.changes) === 0 ? null : this.runByKey(runKey);
  }

  /** The newest instant this automation was scheduled for, or null before any. */
  lastScheduled(automationId: string): number | null {
    const r = this.db.prepare("SELECT MAX(scheduled_at) AS at FROM automation_runs WHERE automation_id = ?").get(automationId) as unknown as { at: number | null };
    return r.at;
  }

  startRun(id: number, threadId: string, leaseMs: number): AutomationRun {
    const now = this.now();
    this.db.prepare("UPDATE automation_runs SET status = 'running', thread_id = ?, started_at = ?, lease_until = ? WHERE id = ?").run(threadId, now, now + leaseMs, id);
    return this.run(id)!;
  }

  renewLease(id: number, leaseMs: number): AutomationRun {
    this.db.prepare("UPDATE automation_runs SET lease_until = ? WHERE id = ?").run(this.now() + leaseMs, id);
    return this.run(id)!;
  }

  finishRun(id: number, f: { status: RunStatus; costUsd?: number | null; inputTokens?: number; outputTokens?: number; result?: string; error?: string }): AutomationRun {
    this.db
      .prepare("UPDATE automation_runs SET status = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, result = ?, error = ?, ended_at = ?, lease_until = NULL WHERE id = ?")
      .run(f.status, f.costUsd ?? null, f.inputTokens ?? null, f.outputTokens ?? null, f.result ?? null, f.error ?? null, this.now(), id);
    return this.run(id)!;
  }

  checkpoint(id: number, data: unknown): void {
    this.db.prepare("UPDATE automation_runs SET checkpoint = ? WHERE id = ?").run(JSON.stringify(data ?? null), id);
  }

  /** Park a run at waiting-input or paused-budget without finishing it. */
  setStatus(id: number, status: RunStatus): void {
    this.db.prepare("UPDATE automation_runs SET status = ? WHERE id = ?").run(status, id);
  }

  /**
   * Any run left in flight whose lease expired is interrupted. `all` (app
   * startup, when no run of this process can be live) ignores the lease.
   */
  interruptStale(all = false): number {
    const now = this.now();
    const info = this.db
      .prepare("UPDATE automation_runs SET status = 'interrupted', ended_at = ? WHERE status IN ('running', 'waiting-input') AND (? = 1 OR lease_until IS NULL OR lease_until < ?)")
      .run(now, all ? 1 : 0, now);
    return Number(info.changes);
  }

  /** Runs claimed but never started (the app quit first), oldest first. */
  queuedRuns(): AutomationRun[] {
    return (this.db.prepare(`SELECT ${RUN_COLS} FROM automation_runs WHERE status = 'queued' ORDER BY scheduled_at, id`).all() as unknown as RawRun[]).map(runOf);
  }

  runs(automationId: string, limit = 20): AutomationRun[] {
    return (this.db.prepare(`SELECT ${RUN_COLS} FROM automation_runs WHERE automation_id = ? ORDER BY scheduled_at DESC, id DESC LIMIT ?`).all(automationId, limit) as unknown as RawRun[]).map(runOf);
  }

  run(id: number): AutomationRun | null {
    const r = this.db.prepare(`SELECT ${RUN_COLS} FROM automation_runs WHERE id = ?`).get(id) as unknown as RawRun | undefined;
    return r ? runOf(r) : null;
  }

  cursor(automationId: string, source: string): SourceCursor {
    const r = this.db.prepare(`SELECT ${CUR_COLS} FROM automation_cursors WHERE automation_id = ? AND source = ?`).get(automationId, source) as unknown as RawCursor | undefined;
    return r ? cursorOf(r) : { automationId, source, bookmark: null, lastOkAt: null, lastStatus: "never", lastError: null, updatedAt: this.now() };
  }

  /** Confirmed progress: the only way a bookmark moves. */
  confirmSource(automationId: string, source: string, bookmark: string): SourceCursor {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO automation_cursors (automation_id, source, bookmark, last_ok_at, last_status, last_error, updated_at)
         VALUES (?, ?, ?, ?, 'ok', NULL, ?)
         ON CONFLICT(automation_id, source) DO UPDATE SET bookmark = excluded.bookmark, last_ok_at = excluded.last_ok_at, last_status = 'ok', last_error = NULL, updated_at = excluded.updated_at`,
      )
      .run(automationId, source, bookmark, now, now);
    return this.cursor(automationId, source);
  }

  /** A source was unreachable; the bookmark stays put so nothing is skipped. */
  failSource(automationId: string, source: string, error: string): SourceCursor {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO automation_cursors (automation_id, source, bookmark, last_ok_at, last_status, last_error, updated_at)
         VALUES (?, ?, NULL, NULL, 'unavailable', ?, ?)
         ON CONFLICT(automation_id, source) DO UPDATE SET last_status = 'unavailable', last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(automationId, source, error, now);
    return this.cursor(automationId, source);
  }

  /** Record the intent to deliver before the send; the key makes a retry a no-op. */
  deliveryIntent(key: string, runId: number, destination: string): Delivery {
    const now = this.now();
    this.db
      .prepare("INSERT OR IGNORE INTO automation_deliveries (idempotency_key, run_id, destination, state, receipt, created_at, updated_at) VALUES (?, ?, ?, 'intent', NULL, ?, ?)")
      .run(key, runId, destination, now, now);
    return this.delivery(key)!;
  }

  markPublished(key: string, receipt?: string): Delivery | null {
    this.db.prepare("UPDATE automation_deliveries SET state = 'published', receipt = COALESCE(?, receipt), updated_at = ? WHERE idempotency_key = ?").run(receipt ?? null, this.now(), key);
    return this.delivery(key);
  }

  confirmDelivery(key: string, receipt?: string): Delivery | null {
    this.db.prepare("UPDATE automation_deliveries SET state = 'confirmed', receipt = COALESCE(?, receipt), updated_at = ? WHERE idempotency_key = ?").run(receipt ?? null, this.now(), key);
    return this.delivery(key);
  }

  /** The destination may or may not have received it; reconcile rather than re-post. */
  markUnknown(key: string): Delivery | null {
    this.db.prepare("UPDATE automation_deliveries SET state = 'unknown', updated_at = ? WHERE idempotency_key = ?").run(this.now(), key);
    return this.delivery(key);
  }

  delivery(key: string): Delivery | null {
    const r = this.db.prepare(`SELECT ${DEL_COLS} FROM automation_deliveries WHERE idempotency_key = ?`).get(key) as unknown as RawDelivery | undefined;
    return r ? deliveryOf(r) : null;
  }

  /** Everything not yet confirmed, to reconcile on startup before any retry. */
  pendingDeliveries(): Delivery[] {
    return (
      this.db.prepare(`SELECT ${DEL_COLS} FROM automation_deliveries WHERE state IN ('intent', 'published', 'unknown') ORDER BY created_at, idempotency_key`).all() as unknown as RawDelivery[]
    ).map(deliveryOf);
  }

  private runByKey(runKey: string): AutomationRun | null {
    const r = this.db.prepare(`SELECT ${RUN_COLS} FROM automation_runs WHERE run_key = ?`).get(runKey) as unknown as RawRun | undefined;
    return r ? runOf(r) : null;
  }
}
