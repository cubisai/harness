import type { StoredEvent, Usage } from "./types";

/** A thread's prompt-cache reuse, rolled up from its reported turns. */
export interface CacheStats {
  /** Turn-end events that carried usage. */
  turns: number;
  /** At least one turn reported its cache reads (ACP agents don't). */
  reported: boolean;
  /** The newest reported turn's hit rate, 0-1. */
  lastHitRate: number | null;
  /** Every reported turn's cache reads over everything it processed, 0-1. */
  sessionHitRate: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The newest turn's true miss, if it was one. */
  lastMiss: { cause: string } | null;
  /** Epoch ms of the newest turn-end, or null before any. */
  lastActivity: number | null;
  ttlMs: number;
  /** Still inside the cache's lifetime at `now`. */
  warm: boolean;
}

/** Plain-English reasons a turn missed the cache, keyed by missCause. */
export const MISS_WORDS: Record<string, string> = {
  "tool-definitions": "tool definitions changed",
  "system-prompt": "system prompt changed",
  model: "model changed",
  compaction: "context compacted",
  "ttl-expiry": "cache expired while idle",
  "session-rebuild": "session reopened",
  unknown: "cause unknown",
};

/** One turn's hit rate: cached reads over cache reads, writes and net-new input. */
function turnHitRate(usage: Usage): number | null {
  if (usage.hitRate !== null) return usage.hitRate;
  const read = usage.cacheReadTokens ?? 0;
  const total = read + (usage.cacheWriteTokens ?? 0) + usage.inputTokens;
  return total > 0 ? read / total : null;
}

/** The cache's lifetime for a reported TTL; anything else reads as the 5-minute default. */
function ttlOf(ttl: Usage["cacheTtl"]): number {
  if (ttl === "1h") return 3_600_000;
  if (ttl === "30m") return 1_800_000;
  return 300_000;
}

/**
 * Roll up a thread's turns into one cache picture. Only `turn-end` events with
 * usage count; the report-sensitive sums ignore turns that didn't report cache
 * reads, so an ACP agent's turns don't drag a session's rate to zero.
 */
export function cacheStats(events: StoredEvent[], now: number): CacheStats {
  const considered: { createdAt: number; usage: Usage }[] = [];
  for (const e of events) {
    if (e.event.kind !== "turn-end" || !e.event.usage) continue;
    considered.push({ createdAt: e.createdAt, usage: e.event.usage });
  }
  const newest = considered[considered.length - 1] ?? null;
  const reported = considered.filter((c) => c.usage.cacheReadTokens !== null);
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let netNewInput = 0;
  for (const c of reported) {
    cacheReadTokens += c.usage.cacheReadTokens ?? 0;
    cacheWriteTokens += c.usage.cacheWriteTokens ?? 0;
    netNewInput += c.usage.inputTokens;
  }
  const sessionTotal = cacheReadTokens + cacheWriteTokens + netNewInput;
  const lastReported = reported[reported.length - 1] ?? null;
  const lastActivity = newest?.createdAt ?? null;
  const ttlMs = ttlOf(newest?.usage.cacheTtl ?? null);
  return {
    turns: considered.length,
    reported: reported.length > 0,
    lastHitRate: lastReported ? turnHitRate(lastReported.usage) : null,
    sessionHitRate: sessionTotal > 0 ? cacheReadTokens / sessionTotal : null,
    cacheReadTokens,
    cacheWriteTokens,
    lastMiss: newest?.usage.miss ? { cause: newest.usage.missCause ?? "unknown" } : null,
    lastActivity,
    ttlMs,
    warm: lastActivity !== null && now - lastActivity < ttlMs,
  };
}
