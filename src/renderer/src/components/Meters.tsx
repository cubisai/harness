import { useEffect, useState } from "react";
import type { AgentLimits, LimitWindow } from "../../../shared/types";
import { useStore } from "../store";
import { CacheMeter } from "./CacheMeter";

/** A reset time as a countdown: "in 45m", "in 2h 14m", "in 3d 4h", or "reset" once passed. */
export function resetCountdown(resetsAt: number, now: number): string {
  const diff = resetsAt - now;
  if (diff <= 0) return "reset";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `in ${hours}h ${rem}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `in ${days}d ${remH}h` : `in ${days}d`;
}

/** How long ago the last report arrived: "just now", "12 min ago", "2h ago", "3d ago". */
export function checkedAgo(updatedAt: number, now: number): string {
  const mins = Math.floor((now - updatedAt) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** A window past its reset no longer counts and reads as refreshing. */
export function isReset(w: LimitWindow, now: number): boolean {
  return w.resetsAt !== null && w.resetsAt <= now;
}

/** The meter's tooltip, from the snapshot and a fixed now so it is testable. */
export function limitTooltip(limits: AgentLimits, now: number): string {
  return [
    ...limits.windows.map((w) =>
      isReset(w, now)
        ? `${w.label}: reset — refreshing`
        : `${w.label} limit: ${w.usedPercent === null ? "in use" : `${w.usedPercent}% used`}, resets ${
            w.resetsAt === null ? "unknown" : resetCountdown(w.resetsAt, now)
          }`,
    ),
    `Checked ${checkedAgo(limits.updatedAt, now)}`,
  ].join("\n");
}

/**
 * The windows the meter shows compactly: the 5-hour one first, then the weekly
 * one (Claude's five_hour / seven_day, Codex's <scope>:primary / <scope>:secondary),
 * falling back to whatever is known when neither is present.
 */
export function meterWindows(known: LimitWindow[]): LimitWindow[] {
  const five = known.find((w) => w.id === "five_hour" || w.id.endsWith(":primary"));
  const week = known.find((w) => w.id === "seven_day" || w.id.endsWith(":secondary"));
  const main = [five, week].filter((w): w is LimitWindow => Boolean(w));
  return main.length ? main : known;
}

/** A compact window label: "5h", "wk", or the window's own label for anything else. */
function shortLabel(w: LimitWindow): string {
  return w.label === "5-hour" ? "5h" : w.label === "Weekly" ? "wk" : w.label;
}

/**
 * The meter's line: the main windows compactly ("5h 35% · wk 12%"), or the
 * "Limit reached · resets …" line once a limit is hit. A window past its reset
 * is excluded. Pure over the snapshot and a fixed now, so it is testable.
 */
export function limitMeterText(limits: AgentLimits, now: number): string {
  const known = limits.windows.filter((w) => w.usedPercent !== null && !isReset(w, now));
  if (limits.state === "limited") {
    const top = known.reduce<LimitWindow | null>((a, w) => (!a || w.usedPercent! > a.usedPercent! ? w : a), null);
    return `Limit reached${top?.resetsAt ? ` · resets ${resetCountdown(top.resetsAt, now)}` : ""}`;
  }
  return meterWindows(known)
    .map((w) => `${shortLabel(w)} ${w.usedPercent}%`)
    .join(" · ");
}

/**
 * How close the thread's agent is to its plan's rate limits: the 5-hour and
 * weekly windows as the agent last reported them. Hidden until the agent
 * reports a window with a known figure (API-key logins never do).
 */
export function LimitMeter({ agent }: { agent: string }) {
  const limits = useStore((s) => s.limits[agent]);
  // The relative times age on their own; re-render once a minute to keep them honest.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  if (!limits) return null;
  const now = Date.now();
  // A window past its reset is out of the running until the refresher replaces it.
  const known = limits.windows.filter((w) => w.usedPercent !== null && !isReset(w, now));
  if (!known.length) return null;
  const pct = meterWindows(known).reduce((m, w) => Math.max(m, w.usedPercent ?? 0), 0);
  return (
    <span className={`limit-meter ${limits.state}`} title={limitTooltip(limits, now)}>
      <span className="bar">
        <i style={{ width: `${limits.state === "limited" ? 100 : pct}%` }} />
      </span>
      {limitMeterText(limits, now)}
    </span>
  );
}

/** What this thread has cost so far, summed over its turns. Quiet until there's something to show. */
export function UsageMeter({ threadId }: { threadId: string }) {
  const events = useStore((s) => s.events[threadId]);
  let input = 0;
  let cached = 0;
  let output = 0;
  let cost = 0;
  let turns = 0;
  for (const e of events ?? []) {
    if (e.event.kind !== "turn-end") continue;
    turns++;
    input += e.event.inputTokens;
    cached += e.event.usage?.cacheReadTokens ?? 0;
    output += e.event.outputTokens;
    cost += e.event.costUsd ?? 0;
  }
  if (!turns) return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
  // Agents report cache reads apart from input: the count is what each turn added, not the context it sent.
  const title = [
    `${turns} turn${turns === 1 ? "" : "s"}`,
    `Uncached input: ${input.toLocaleString()} tokens`,
    `Cached input (read from cache): ${cached.toLocaleString()} tokens`,
    `Output: ${output.toLocaleString()} tokens`,
    ...(cost > 0 ? [`Cost: $${cost.toFixed(2)}, cached reads included`] : []),
  ].join("\n");
  return (
    <span className="usage" title={title}>
      {k(input + output)} uncached tokens{cost > 0 ? ` · $${cost.toFixed(2)}` : ""}
    </span>
  );
}

/** A compact token count: 950, 8.2k, 40k, 200k, 1.5M. */
export function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** The context meter's label, or null when no context input has been seen. */
export function contextMeterText(used: number | null | undefined, size: number | null | undefined): string | null {
  if (typeof used !== "number") return null;
  return typeof size === "number" ? `${fmt(used)} / ${fmt(size)}` : `${fmt(used)} context`;
}

/**
 * How full the model's context window is: the latest live figure, else the last
 * stored turn's. Quiet until an agent reports a context input.
 */
export function ContextMeter({ threadId }: { threadId: string }) {
  const live = useStore((s) => s.live[threadId]);
  const events = useStore((s) => s.events[threadId]);
  // The last stored turn's figures; a live turn's usage overrides what it reports.
  let used: number | null = null;
  let size: number | null = null;
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events![i]!.event;
    if (e.kind !== "turn-end" || typeof e.usage?.contextUsed !== "number") continue;
    used = e.usage.contextUsed;
    size = typeof e.usage.contextSize === "number" ? e.usage.contextSize : null;
    break;
  }
  // Mid-turn, Claude reports the context used but not the window (that comes
  // with the result): keep the stored window so the meter doesn't flicker.
  if (typeof live?.usage?.contextUsed === "number") used = live.usage.contextUsed;
  if (typeof live?.usage?.contextSize === "number") size = live.usage.contextSize;
  const text = contextMeterText(used, size);
  if (text === null) return null;
  const pct = typeof size === "number" && size > 0 ? Math.round((used! / size) * 100) : null;
  const title =
    typeof size === "number"
      ? `${used!.toLocaleString()} of ${size.toLocaleString()} tokens in context (${pct}%)`
      : `${used!.toLocaleString()} tokens in context`;
  return (
    <span className={`usage context-meter${pct !== null && pct >= 80 ? " warn" : ""}`} title={title}>
      {text}
    </span>
  );
}

/** The thread's plan limit, usage and cache figures: quiet, beside the send button. */
export function ThreadMeters({ agent, threadId }: { agent: string; threadId: string }) {
  return (
    <div className="thread-meters">
      <LimitMeter agent={agent} />
      <UsageMeter threadId={threadId} />
      <ContextMeter threadId={threadId} />
      <CacheMeter threadId={threadId} />
    </div>
  );
}
