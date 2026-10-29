import { MISS_WORDS, cacheStats, type CacheStats } from "../../../shared/cache-stats";
import { useStore } from "../store";

/** The one-line cache readout for a thread, or null when there's nothing to say yet. */
export function cacheMeterText(stats: CacheStats): string | null {
  if (stats.turns === 0) return null;
  if (!stats.reported) return "cache —";
  return `cache ${Math.round((stats.lastHitRate ?? 0) * 100)}%${stats.lastMiss ? " · miss" : ""}`;
}

/**
 * How much of this thread's input came from the prompt cache, from its stored
 * turns. Quiet until a turn lands; silent about numbers an agent never reports.
 */
export function CacheMeter({ threadId }: { threadId: string }) {
  const events = useStore((s) => s.events[threadId]);
  const live = useStore((s) => s.live[threadId]);
  const stats = cacheStats(events ?? [], Date.now());
  const text = cacheMeterText(stats);
  if (text === null) return null;
  if (!stats.reported) {
    return (
      <span className="usage" title="This agent doesn't report prompt-cache use">
        {text}
      </span>
    );
  }
  const pct = (n: number | null) => `${Math.round((n ?? 0) * 100)}%`;
  const lines = [
    `This turn: ${pct(stats.lastHitRate)} read from cache`,
    `Session: ${pct(stats.sessionHitRate)} (${stats.cacheReadTokens.toLocaleString()} read, ${stats.cacheWriteTokens.toLocaleString()} written)`,
  ];
  if (stats.lastMiss) lines.push(`Miss this turn: ${MISS_WORDS[stats.lastMiss.cause] ?? "cause unknown"}`);
  if (stats.warm) lines.push(`Warm: the cache lasts ${ttlLabel(stats.ttlMs)} after the last turn`);
  else if (stats.lastActivity !== null) lines.push(`Cold: last turn at ${new Date(stats.lastActivity).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`);
  const now = live?.usage?.cacheReadTokens;
  if (now != null) lines.push(`Now: ${now.toLocaleString()} tokens read from cache`);
  return (
    <span className={stats.lastMiss ? "limit-meter warning" : "usage"} title={lines.join("\n")}>
      {text}
    </span>
  );
}

function ttlLabel(ms: number): string {
  if (ms === 3_600_000) return "1 hour";
  if (ms === 1_800_000) return "30 minutes";
  return "5 minutes";
}
