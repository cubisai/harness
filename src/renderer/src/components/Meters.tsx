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

/** The thread's plan limit, usage and cache figures: quiet, beside the send button. */
export function ThreadMeters({ agent, threadId }: { agent: string; threadId: string }) {
  return (
    <div className="thread-meters">
      <LimitMeter agent={agent} />
      <UsageMeter threadId={threadId} />
      <CacheMeter threadId={threadId} />
    </div>
  );
}
