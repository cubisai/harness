import type { AgentLimits, LimitWindow } from "../../shared/types";

/** A partial report from one agent: windows it mentioned, and state if it knows it. */
export interface LimitsPatch {
  windows?: LimitWindow[];
  /** Set when the agent said so outright (a rejection, a warning). */
  state?: AgentLimits["state"];
  plan?: string | null;
  /** A full snapshot (an on-demand read): its windows replace the known ones instead of merging. */
  complete?: boolean;
}

export type LimitsListener = (patch: LimitsPatch) => void;

const WARN_AT = 80;
const SAVE_DEBOUNCE_MS = 1000;

/** Where the tracker's snapshots survive a restart; both sides are best-effort. */
export interface LimitsPersistence {
  load(): AgentLimits[];
  save(all: AgentLimits[]): void;
}

/**
 * Keeps each agent's latest rate limits. Reports are partial (Codex's are
 * sparse by design, Claude sends one window per event), so they merge into
 * what's known; a listener hears only real changes, so a burst of identical
 * reports during a turn never reaches the UI. Snapshots can be loaded from
 * and saved to disk, so the UI isn't empty after a restart.
 */
export class LimitsTracker {
  private byAgent = new Map<string, AgentLimits>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private onChange: (limits: AgentLimits) => void,
    private persistence?: LimitsPersistence,
  ) {
    // Seed from disk silently: loading isn't a change anyone needs to hear.
    for (const l of this.persistence?.load() ?? []) this.byAgent.set(l.agent, l);
  }

  update(agent: string, patch: LimitsPatch, now = Date.now()): void {
    const prev = this.byAgent.get(agent);
    const windows = new Map((patch.complete ? [] : (prev?.windows ?? [])).map((w) => [w.id, w]));
    for (const w of patch.windows ?? []) {
      const old = windows.get(w.id);
      // A report without a number keeps the last one we had.
      windows.set(w.id, { ...w, usedPercent: w.usedPercent ?? old?.usedPercent ?? null, resetsAt: w.resetsAt ?? old?.resetsAt ?? null });
    }
    const list = [...windows.values()];
    // A window past its reset no longer counts: the next report may be hours
    // away, so a limit that's over would otherwise stick.
    const live = list.filter((w) => w.resetsAt === null || w.resetsAt > now);
    const highest = Math.max(0, ...live.map((w) => w.usedPercent ?? 0));
    const derived: AgentLimits["state"] = highest >= 100 ? "limited" : highest >= WARN_AT ? "warning" : "ok";
    // A held "limited" (reported without windows) clears once every window it
    // was tied to has reset; with no windows at all, there's nothing to judge.
    const held = prev?.state === "limited" && !(list.length > 0 && list.every((w) => w.resetsAt !== null && w.resetsAt <= now));
    const next: AgentLimits = {
      agent,
      windows: list,
      state: patch.state ?? (held && !patch.windows ? "limited" : derived),
      plan: patch.plan ?? prev?.plan ?? null,
      updatedAt: now,
    };
    this.byAgent.set(agent, next);
    if (!prev || JSON.stringify({ ...prev, updatedAt: 0 }) !== JSON.stringify({ ...next, updatedAt: 0 })) {
      this.onChange(next);
      this.scheduleSave();
    }
  }

  all(): AgentLimits[] {
    return [...this.byAgent.values()];
  }

  /** When this agent's snapshot was last updated (a push or a probe), or null. */
  lastChecked(agent: string): number | null {
    return this.byAgent.get(agent)?.updatedAt ?? null;
  }

  /** A listener for one agent's driver. */
  for(agent: string): LimitsListener {
    return (patch) => this.update(agent, patch);
  }

  /** Persist after the report burst settles, not on every window. */
  private scheduleSave(): void {
    if (!this.persistence) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistence!.save(this.all());
    }, SAVE_DEBOUNCE_MS);
  }
}

const toMs = (t: number | null | undefined): number | null =>
  typeof t === "number" && Number.isFinite(t) ? (t < 1e12 ? t * 1000 : t) : null;

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly Opus",
  seven_day_sonnet: "Weekly Sonnet",
  seven_day_oauth_apps: "Weekly (apps)",
  seven_day_overage_included: "Weekly",
  overage: "Extra usage",
};

/** The fields of the Agent SDK's SDKRateLimitInfo this reads. */
export interface ClaudeRateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: string;
  /** A fraction, 0-1, from the API's unified rate-limit headers. */
  utilization?: number;
  /** The other windows from the same response, e.g. seven_day next to five_hour. */
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
}

/** Claude's `rate_limit_event`: one window per event, for claude.ai plans only. */
export function claudeLimitsPatch(info: ClaudeRateLimitInfo): LimitsPatch {
  const state = info.status === "rejected" ? "limited" : info.status === "allowed_warning" ? "warning" : undefined;
  const pct = (u: number | undefined) => (typeof u === "number" ? Math.min(100, Math.max(0, Math.round(u * 100))) : null);
  const windows: LimitWindow[] = [];
  const add = (id: string, utilization: number | undefined, resetsAt: number | undefined) => {
    if (!windows.some((w) => w.id === id)) windows.push({ id, label: CLAUDE_WINDOWS[id] ?? id, usedPercent: pct(utilization), resetsAt: toMs(resetsAt) });
  };
  if (info.rateLimitType) add(info.rateLimitType, info.utilization, info.resetsAt);
  for (const [id, w] of Object.entries(info.unifiedWindows ?? {})) if (w) add(id, w.utilization, w.resetsAt);
  return { ...(windows.length && { windows }), ...(state && { state }) };
}

/** One window of the on-demand usage response (utilization is already 0-100). */
export interface ClaudeUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

/** The fields of Claude's `usage_EXPERIMENTAL…` response (`/usage`) this reads. */
export interface ClaudeUsage {
  rate_limits_available?: boolean;
  subscription_type?: string | null;
  rate_limits?: {
    five_hour?: ClaudeUsageWindow | null;
    seven_day?: ClaudeUsageWindow | null;
    seven_day_opus?: ClaudeUsageWindow | null;
    seven_day_sonnet?: ClaudeUsageWindow | null;
    seven_day_oauth_apps?: ClaudeUsageWindow | null;
  } | null;
}

/**
 * Claude's on-demand `/usage` answer: every present window, already a 0-100
 * percentage (unlike the rate_limit_event's 0-1 fraction). The caller turns
 * `rate_limits_available === false` into "unsupported" before mapping.
 */
/** The plan windows the SDK's usage read documents, in display order. */
const CLAUDE_USAGE_WINDOWS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps"] as const;

export function claudeUsagePatch(res: ClaudeUsage): LimitsPatch {
  const pct = (u: number | null | undefined) => (typeof u === "number" ? Math.min(100, Math.max(0, Math.round(u))) : null);
  const reset = (t: string | null | undefined) => {
    if (!t) return null;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  };
  const windows: LimitWindow[] = [];
  // Only the documented windows: the object also carries internal meters under
  // codenames and non-window fields (spend, extra usage), which aren't the plan's limits.
  for (const id of CLAUDE_USAGE_WINDOWS) {
    const w = (res.rate_limits as Record<string, { utilization?: number | null; resets_at?: string | null } | null | undefined> | null)?.[id];
    if (!w || typeof w !== "object") continue;
    windows.push({ id, label: CLAUDE_WINDOWS[id] ?? id, usedPercent: pct(w.utilization), resetsAt: reset(w.resets_at) });
  }
  return {
    // An empty read (rate_limits null while the CLI's usage fetch fails) must not wipe good figures.
    ...(windows.length ? { windows, complete: true } : {}),
    ...(res.subscription_type ? { plan: res.subscription_type } : {}),
  };
}

interface CodexWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

/** The fields of Codex's RateLimitSnapshot (`account/rateLimits/updated`) this reads. */
export interface CodexRateLimits {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

function windowLabel(mins: number | null | undefined, fallback: string): string {
  if (!mins) return fallback;
  if (mins === 10080) return "Weekly";
  if (mins % 1440 === 0) return `${mins / 1440}-day`;
  if (mins % 60 === 0) return `${mins / 60}-hour`;
  return `${mins}-minute`;
}

/** Codex's sparse rate-limit update: absent fields mean "unchanged", not "cleared". */
export function codexLimitsPatch(r: CodexRateLimits): LimitsPatch {
  const scope = r.limitId && r.limitId !== "codex" ? r.limitId : "codex";
  const prefix = scope === "codex" ? "" : `${r.limitName ?? scope} `;
  const windows: LimitWindow[] = [];
  for (const [slot, w] of [["primary", r.primary], ["secondary", r.secondary]] as const) {
    if (!w) continue;
    windows.push({
      id: `${scope}:${slot}`,
      label: prefix + windowLabel(w.windowDurationMins, slot === "primary" ? "Short-term" : "Long-term"),
      usedPercent: Math.min(100, Math.max(0, Math.round(w.usedPercent))),
      resetsAt: toMs(w.resetsAt),
    });
  }
  return {
    ...(windows.length && { windows }),
    ...(r.rateLimitReachedType && { state: "limited" as const }),
    ...(r.planType && r.planType !== "unknown" && { plan: r.planType }),
  };
}

/** The fields of Codex's `account/rateLimits/read` response this reads. */
export interface CodexRateLimitsRead {
  rateLimits?: CodexRateLimits | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimits> | null;
}

/** Merge every snapshot an on-demand read returned into one patch. */
export function codexReadPatch(res: CodexRateLimitsRead): LimitsPatch {
  const byId = res.rateLimitsByLimitId;
  const snapshots = byId && Object.keys(byId).length ? Object.values(byId) : res.rateLimits ? [res.rateLimits] : [];
  const windows: LimitWindow[] = [];
  let state: LimitsPatch["state"];
  let plan: string | null | undefined;
  for (const s of snapshots) {
    const p = codexLimitsPatch(s);
    if (p.windows) windows.push(...p.windows);
    if (p.state) state = p.state;
    if (p.plan) plan = p.plan;
  }
  return { ...(windows.length && { windows, complete: true }), ...(state && { state }), ...(plan && { plan }) };
}
