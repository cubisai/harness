import type { AgentLimits, LimitWindow } from "../../shared/types";

/** A partial report from one agent: windows it mentioned, and state if it knows it. */
export interface LimitsPatch {
  windows?: LimitWindow[];
  /** Set when the agent said so outright (a rejection, a warning). */
  state?: AgentLimits["state"];
  plan?: string | null;
}

export type LimitsListener = (patch: LimitsPatch) => void;

const WARN_AT = 80;

/**
 * Keeps each agent's latest rate limits. Reports are partial (Codex's are
 * sparse by design, Claude sends one window per event), so they merge into
 * what's known; a listener hears only real changes, so a burst of identical
 * reports during a turn never reaches the UI.
 */
export class LimitsTracker {
  private byAgent = new Map<string, AgentLimits>();

  constructor(private onChange: (limits: AgentLimits) => void) {}

  update(agent: string, patch: LimitsPatch, now = Date.now()): void {
    const prev = this.byAgent.get(agent);
    const windows = new Map((prev?.windows ?? []).map((w) => [w.id, w]));
    for (const w of patch.windows ?? []) {
      const old = windows.get(w.id);
      // A report without a number keeps the last one we had.
      windows.set(w.id, { ...w, usedPercent: w.usedPercent ?? old?.usedPercent ?? null, resetsAt: w.resetsAt ?? old?.resetsAt ?? null });
    }
    const list = [...windows.values()];
    const highest = Math.max(0, ...list.map((w) => w.usedPercent ?? 0));
    const derived: AgentLimits["state"] = highest >= 100 ? "limited" : highest >= WARN_AT ? "warning" : "ok";
    const next: AgentLimits = {
      agent,
      windows: list,
      state: patch.state ?? (prev?.state === "limited" && !patch.windows ? "limited" : derived),
      plan: patch.plan ?? prev?.plan ?? null,
      updatedAt: now,
    };
    this.byAgent.set(agent, next);
    if (!prev || JSON.stringify({ ...prev, updatedAt: 0 }) !== JSON.stringify({ ...next, updatedAt: 0 })) this.onChange(next);
  }

  all(): AgentLimits[] {
    return [...this.byAgent.values()];
  }

  /** A listener for one agent's driver. */
  for(agent: string): LimitsListener {
    return (patch) => this.update(agent, patch);
  }
}

const toMs = (t: number | null | undefined): number | null =>
  typeof t === "number" && Number.isFinite(t) ? (t < 1e12 ? t * 1000 : t) : null;

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly Opus",
  seven_day_sonnet: "Weekly Sonnet",
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
