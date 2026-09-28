import { useStore } from "../store";
import { CacheMeter } from "./CacheMeter";

/**
 * How close the thread's agent is to its plan's rate limits: the fullest
 * window, as the agent last reported it. Hidden until the agent reports
 * any (API-key logins never do), and quiet below half.
 */
export function LimitMeter({ agent }: { agent: string }) {
  const limits = useStore((s) => s.limits[agent]);
  if (!limits) return null;
  const known = limits.windows.filter((w) => w.usedPercent !== null);
  const top = known.reduce<(typeof known)[number] | null>((a, w) => (!a || w.usedPercent! > a.usedPercent! ? w : a), null);
  if (!top && limits.state === "ok") return null;
  const pct = top?.usedPercent ?? 0;
  if (limits.state === "ok" && pct < 50) return null;
  const when = (ms: number | null) =>
    ms ? new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "unknown";
  const title = [
    ...limits.windows.map((w) => `${w.label} limit: ${w.usedPercent === null ? "in use" : `${w.usedPercent}% used`}, resets ${when(w.resetsAt)}`),
    `As of ${new Date(limits.updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
  ].join("\n");
  const text =
    limits.state === "limited"
      ? `Limit reached${top?.resetsAt ? ` · resets ${when(top.resetsAt)}` : ""}`
      : `${top!.label} limit ${pct}%`;
  return (
    <span className={`limit-meter ${limits.state}`} title={title}>
      <span className="bar">
        <i style={{ width: `${limits.state === "limited" ? 100 : pct}%` }} />
      </span>
      {text}
    </span>
  );
}

/** What this thread has cost so far, summed over its turns. Quiet until there's something to show. */
export function UsageMeter({ threadId }: { threadId: string }) {
  const events = useStore((s) => s.events[threadId]);
  let input = 0;
  let output = 0;
  let cost = 0;
  let turns = 0;
  for (const e of events ?? []) {
    if (e.event.kind !== "turn-end") continue;
    turns++;
    input += e.event.inputTokens;
    output += e.event.outputTokens;
    cost += e.event.costUsd ?? 0;
  }
  if (!turns) return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
  return (
    <span className="usage" title={`${turns} turn${turns === 1 ? "" : "s"} · ${input.toLocaleString()} input and ${output.toLocaleString()} output tokens`}>
      {k(input + output)} tokens{cost > 0 ? ` · $${cost.toFixed(2)}` : ""}
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
  let used: number | null = null;
  let size: number | null = null;
  if (typeof live?.usage?.contextUsed === "number") {
    used = live.usage.contextUsed;
    size = typeof live.usage.contextSize === "number" ? live.usage.contextSize : null;
  } else {
    for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
      const e = events![i]!.event;
      if (e.kind !== "turn-end") continue;
      if (typeof e.usage?.contextUsed !== "number") continue;
      used = e.usage.contextUsed;
      size = typeof e.usage.contextSize === "number" ? e.usage.contextSize : null;
      break;
    }
  }
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
