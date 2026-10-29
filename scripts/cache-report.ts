// Prompt-cache report per agent and model, read from an app profile's unskilled.db.
// It answers "how much of what each agent sends is a cache read?". A cache read
// is billed at about a tenth of fresh input, so a few points of hit rate move the bill.
//
//   bun run cache:report [path/to/unskilled.db] [--days N] [--json]
//
// The default is the installed app's profile (CubiQ). Only top-level turns count
// (a subagent's turn-end has a parent). "Warm" leaves out each thread's first
// turn, which always writes the cache. Agents that don't report cache reads
// (some ACP agents) show as "not reported" instead of 0%.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MISS_WORDS } from "../src/shared/cache-stats";
import type { ThreadEvent, Usage } from "../src/shared/types";

/** One top-level turn-start or turn-end, oldest first within a thread. */
export interface ReportRow {
  threadId: string;
  agent: string;
  event: ThreadEvent;
}

export interface ReportLine {
  agent: string;
  model: string;
  turns: number;
  /** Turns whose usage said how many tokens came from the cache. */
  reported: number;
  /** Cache reads over everything the reported turns sent (reads + writes + fresh input), 0-1. */
  hitRate: number | null;
  /** The same, without each thread's first turn. */
  warmHitRate: number | null;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  costUsd: number;
  /** Unexpected misses by cause. */
  misses: Record<string, number>;
}

interface Sums {
  read: number;
  write: number;
  input: number;
}

const rate = (s: Sums) => {
  const total = s.read + s.write + s.input;
  return total > 0 ? s.read / total : null;
};

/** Roll the turns up per agent and model; the model is the one the turn started with. */
export function cacheReport(rows: ReportRow[]): ReportLine[] {
  const lines = new Map<string, ReportLine & { all: Sums; warm: Sums }>();
  const modelOf = new Map<string, string>();
  const seen = new Set<string>();
  for (const { threadId, agent, event } of rows) {
    if (event.kind === "turn-start") {
      modelOf.set(threadId, event.model);
      continue;
    }
    if (event.kind !== "turn-end") continue;
    const model = modelOf.get(threadId) ?? "unknown";
    const key = `${agent}\u0000${model}`;
    let line = lines.get(key);
    if (!line) {
      line = { agent, model, turns: 0, reported: 0, hitRate: null, warmHitRate: null, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, costUsd: 0, misses: {}, all: { read: 0, write: 0, input: 0 }, warm: { read: 0, write: 0, input: 0 } };
      lines.set(key, line);
    }
    const first = !seen.has(threadId);
    seen.add(threadId);
    line.turns += 1;
    line.costUsd += event.costUsd ?? 0;
    const u: Usage | undefined = event.usage;
    line.input += u?.inputTokens ?? event.inputTokens;
    line.output += u?.outputTokens ?? event.outputTokens;
    if (!u || u.cacheReadTokens === null) continue;
    line.reported += 1;
    const read = u.cacheReadTokens;
    const write = u.cacheWriteTokens ?? 0;
    line.cacheRead += read;
    line.cacheWrite += write;
    for (const sums of first ? [line.all] : [line.all, line.warm]) {
      sums.read += read;
      sums.write += write;
      sums.input += u.inputTokens;
    }
    if (u.miss && u.missCause) line.misses[u.missCause] = (line.misses[u.missCause] ?? 0) + 1;
  }
  return [...lines.values()]
    .map(({ all, warm, ...line }) => ({ ...line, hitRate: rate(all), warmHitRate: rate(warm) }))
    .sort((a, b) => b.turns - a.turns || a.agent.localeCompare(b.agent));
}

/** The installed app's database on this platform. */
export function defaultDb(platform = process.platform, env = process.env): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "CubiQ", "unskilled.db");
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "CubiQ", "unskilled.db");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "CubiQ", "unskilled.db");
}

function readRows(file: string, sinceMs: number): ReportRow[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const raw = db
      .prepare(
        `SELECT e.thread_id AS threadId, t.agent AS agent, e.payload AS payload FROM events e JOIN threads t ON t.id = e.thread_id
         WHERE e.parent_id IS NULL AND e.created_at >= ? AND json_extract(e.payload, '$.kind') IN ('turn-start', 'turn-end')
         ORDER BY e.thread_id, e.seq`,
      )
      .all(sinceMs) as { threadId: string; agent: string; payload: string }[];
    return raw.map((r) => ({ threadId: r.threadId, agent: r.agent, event: JSON.parse(r.payload) as ThreadEvent }));
  } finally {
    db.close();
  }
}

const pct = (n: number | null) => (n === null ? "not reported" : `${(n * 100).toFixed(1)}%`);
const kTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${(n / 1000).toFixed(1)}k`);

/** The report as a plain-text table. */
export function formatReport(lines: ReportLine[]): string {
  if (!lines.length) return "No turns in this range.";
  const head = ["Agent", "Model", "Turns", "Hit", "Warm hit", "Cache read", "Cache write", "Fresh in", "Out", "Cost", "Misses"];
  const body = lines.map((l) => [
    l.agent,
    l.model,
    String(l.turns),
    l.reported ? pct(l.hitRate) : "not reported",
    l.warmHitRate === null ? "—" : pct(l.warmHitRate),
    kTok(l.cacheRead),
    kTok(l.cacheWrite),
    kTok(l.input),
    kTok(l.output),
    `$${l.costUsd.toFixed(3)}`,
    Object.entries(l.misses).map(([cause, n]) => `${n} ${MISS_WORDS[cause] ?? cause}`).join(", ") || "—",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  return [head, ...body].map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? null : (args.splice(i, 2)[1] ?? "");
  };
  const days = Number(flag("--days") ?? "0");
  const json = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--")) ?? defaultDb();
  if (!existsSync(file)) {
    console.error(`No database at ${file}. Pass the path to a profile's unskilled.db.`);
    process.exit(1);
  }
  const lines = cacheReport(readRows(file, days > 0 ? Date.now() - days * 86_400_000 : 0));
  console.log(json ? JSON.stringify(lines, null, 2) : formatReport(lines));
}
