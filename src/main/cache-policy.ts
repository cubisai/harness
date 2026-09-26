/**
 * Cache policy: what the harness does to an agent's prompt prefix.
 *
 * The harness doesn't build the Anthropic/OpenAI request itself (the agents
 * do), so the fingerprint covers what the harness hands them: its own tools
 * and the user's MCP servers. Where the cache breakpoints go is the agents'
 * responsibility, not ours. The compaction knob builders (`claudeCompactEnv`,
 * `codexCompactConfig`) are not wired into agents by default — they would
 * change when users' sessions compact — so they follow up behind a setting.
 */

import { createHash } from "node:crypto";
import type { McpServerEntry, MissCause, Usage } from "../shared/types";
import type { HarnessTool } from "./agents/types";

export { cacheStats, MISS_WORDS, type CacheStats } from "../shared/cache-stats";

/** JSON with object keys sorted recursively (arrays keep their order). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** What the harness hands an agent that shapes its cached prefix. */
export interface PinnedToolSet {
  tools: readonly { name: string; description: string; input: string[] }[];
  servers: readonly string[];
}

/** The pinned set for a turn: harness tools by name, enabled MCP servers as stable JSON. Frozen. */
export function toolSetOf(tools: HarnessTool[], servers: McpServerEntry[]): PinnedToolSet {
  const pinnedTools = tools
    .map((t) => ({ name: t.name, description: t.description, input: Object.keys(t.input).sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const pinnedServers = servers
    .filter((s) => s.enabled)
    .map((s) => stableStringify({ name: s.name, spec: s.spec }))
    .sort();
  for (const t of pinnedTools) Object.freeze(t.input);
  Object.freeze(pinnedTools);
  Object.freeze(pinnedServers);
  return Object.freeze({ tools: pinnedTools, servers: pinnedServers });
}

/** sha256 hex of the pinned set, for comparing one turn's prefix to the last. */
export function fingerprint(set: PinnedToolSet): string {
  return createHash("sha256").update(stableStringify(set)).digest("hex");
}

/**
 * The pinned set per thread, and config changes queued since the last drain.
 * In-memory only: a restart starts a new session, so there's nothing to pin
 * against.
 */
const pinned = new Map<string, PinnedToolSet>();
const pending = new Map<string, { set: PinnedToolSet }[]>();

/** Pin this thread's set (normally its first turn) and return it. */
export function pinToolSet(threadId: string, set: PinnedToolSet): PinnedToolSet {
  pinned.set(threadId, set);
  return set;
}

/** The set this thread is currently pinned to, or null before its first turn. */
export function pinnedSet(threadId: string): PinnedToolSet | null {
  return pinned.get(threadId) ?? null;
}

/** The fingerprint this thread is pinned to, or null before its first turn. */
export function pinnedFingerprint(threadId: string): string | null {
  const set = pinned.get(threadId);
  return set ? fingerprint(set) : null;
}

/** Queue a changed set without touching the pinned fingerprint: it changes only at a drain. */
export function queueConfigChange(threadId: string, change: { set: PinnedToolSet }): void {
  const list = pending.get(threadId);
  if (list) list.push(change);
  else pending.set(threadId, [change]);
}

/** Return and clear queued changes, re-pinning to the last one so the fingerprint catches up. */
export function drainConfigChanges(threadId: string): { set: PinnedToolSet }[] {
  const drained = pending.get(threadId) ?? [];
  pending.delete(threadId);
  const last = drained[drained.length - 1];
  if (last) pinToolSet(threadId, last.set);
  return drained;
}

/** Drop a thread's pinned state; for tests. */
export function forgetThread(threadId: string): void {
  pinned.delete(threadId);
  pending.delete(threadId);
}

/** A cache miss: a cache write too large to be an ordinary incremental append. */
export function isMiss(prevPrefix: number, cacheWrite: number): boolean {
  return cacheWrite >= 2000 && cacheWrite > 0.05 * prevPrefix;
}

/**
 * Name the first signal that explains a miss. Compaction, TTL expiry and a
 * session rebuild are expected (the agent had a reason); the rest mean the
 * prefix changed without one.
 */
export function classifyMiss(s: {
  toolFingerprintChanged?: boolean;
  systemPromptChanged?: boolean;
  modelChanged?: boolean;
  compacted?: boolean;
  ttlExpired?: boolean;
  sessionRebuilt?: boolean;
}): { cause: MissCause; expected: boolean } {
  if (s.toolFingerprintChanged) return { cause: "tool-definitions", expected: false };
  if (s.systemPromptChanged) return { cause: "system-prompt", expected: false };
  if (s.modelChanged) return { cause: "model", expected: false };
  if (s.compacted) return { cause: "compaction", expected: true };
  if (s.ttlExpired) return { cause: "ttl-expiry", expected: true };
  if (s.sessionRebuilt) return { cause: "session-rebuild", expected: true };
  return { cause: "unknown", expected: false };
}

/** The prompt cache's lifetime for a reported TTL; anything unknown reads as the 5-minute default. */
function ttlMs(ttl: Usage["cacheTtl"]): number {
  if (ttl === "1h") return 60 * 60_000;
  if (ttl === "30m") return 30 * 60_000;
  return 5 * 60_000;
}

/**
 * Mark a turn-end's usage as a miss (and why), comparing its cache write to
 * the previous turn's processed prefix and to what idled in between. Returns
 * a new Usage; the first turn has nothing to compare, so it's only marked
 * when the driver rebuilt the session.
 */
export function annotateUsage(
  usage: Usage,
  ctx: { prev: Usage | null; idleMs: number | null; signals: Omit<Parameters<typeof classifyMiss>[0], "ttlExpired"> },
): Usage {
  if (ctx.prev === null) {
    return ctx.signals.sessionRebuilt ? { ...usage, miss: false, missCause: "session-rebuild" } : { ...usage };
  }
  const prevPrefix = (ctx.prev.cacheReadTokens ?? 0) + (ctx.prev.cacheWriteTokens ?? 0) + ctx.prev.inputTokens;
  const ttlExpired = ctx.idleMs !== null && ctx.idleMs > ttlMs(ctx.prev.cacheTtl);
  if (isMiss(prevPrefix, usage.cacheWriteTokens ?? 0)) {
    const { cause, expected } = classifyMiss({ ...ctx.signals, ttlExpired });
    return { ...usage, miss: !expected, missCause: cause };
  }
  // A rebuild that happened to stay cheap is still worth recording.
  return ctx.signals.sessionRebuilt ? { ...usage, miss: false, missCause: "session-rebuild" } : { ...usage };
}

/** Compact when the context is down to this fraction of its window. */
export const COMPACT_AT = 0.2;

/** Whether now is a safe point to compact: only between turns, and never around a switch. */
export function shouldCompact(s: {
  remaining: number;
  window: number;
  atTurnBoundary: boolean;
  midToolCall?: boolean;
  pendingSwitch?: boolean;
  justSwitched?: boolean;
}): boolean {
  return (
    s.atTurnBoundary &&
    !s.midToolCall &&
    !s.pendingSwitch &&
    !s.justSwitched &&
    s.window > 0 &&
    s.remaining / s.window <= COMPACT_AT
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Claude's auto-compaction knobs, as environment variables for its process. */
export function claudeCompactEnv(p: { window: number; pct?: number; ttl?: "5m" | "1h" }): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(clamp(Math.round(p.window), 100_000, 1_000_000)),
  };
  if (p.pct !== undefined) env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(clamp(Math.round(p.pct), 1, 100));
  if (p.ttl !== undefined) env.CLAUDE_CODE_PROMPT_CACHE_TTL = p.ttl;
  return env;
}

/** Codex's auto-compaction knobs, as config keys for its thread. */
export function codexCompactConfig(p: { tokenLimit: number }): Record<string, string | number> {
  return {
    model_auto_compact_token_limit: Math.round(p.tokenLimit),
    model_auto_compact_token_limit_scope: "body_after_prefix",
  };
}
