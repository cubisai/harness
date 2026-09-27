// Rollback trigger 3 (plan/docs/rollback.md): the cache hit rate over the 7
// days after the M4.5 release against the 7 days before it, read from the
// app's own database. Nothing leaves the machine.
//
//   node scripts/rollback-check.mjs --since <M4.5 release date, e.g. 2026-10-01> [--db <path to unskilled.db>]
//
// Prints both windows' cumulative hit rates, the delta, and PASS/FAIL against
// -5 percentage points; exits 1 on FAIL, 2 when a window has no data.
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DAY = 24 * 60 * 60 * 1000;
export const HIT_RATE_TRIGGER = -0.05;

/**
 * Σread / Σ(read + write + net-new input) over the turns that reported cache
 * reads — the same rule as cumulativeHitRate in src/main/cache-policy.ts (a
 * test keeps the two in step). Not the mean of per-turn rates.
 */
export function cumulativeHitRate(usages) {
  let read = 0;
  let total = 0;
  let turns = 0;
  for (const u of usages) {
    if (u.cacheReadTokens === null || u.cacheReadTokens === undefined) continue;
    turns++;
    read += u.cacheReadTokens;
    total += u.cacheReadTokens + (u.cacheWriteTokens ?? 0) + u.inputTokens;
  }
  return turns === 0 || total === 0 ? null : read / total;
}

/** Turn-end usage in [from, to) from an open node:sqlite database. */
export function usageBetween(db, from, to) {
  return db
    .prepare("SELECT payload FROM events WHERE created_at >= ? AND created_at < ? ORDER BY created_at")
    .all(from, to)
    .map((r) => JSON.parse(r.payload))
    .filter((e) => e.kind === "turn-end" && e.usage)
    .map((e) => e.usage);
}

/** The two 7-day windows around `since` and the verdict. */
export function verdict(db, since) {
  const baseline = cumulativeHitRate(usageBetween(db, since - 7 * DAY, since));
  const current = cumulativeHitRate(usageBetween(db, since, since + 7 * DAY));
  const delta = baseline === null || current === null ? null : current - baseline;
  return { baseline, current, delta, pass: delta === null ? null : delta > HIT_RATE_TRIGGER };
}

function defaultDb() {
  const name = "AI Harness";
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), name, "unskilled.db");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", name, "unskilled.db");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), name, "unskilled.db");
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const sinceText = arg("--since");
  const since = sinceText ? Date.parse(sinceText) : NaN;
  if (Number.isNaN(since)) {
    console.error("usage: node scripts/rollback-check.mjs --since <M4.5 release date> [--db <path>]");
    process.exit(2);
  }
  const file = arg("--db") ?? defaultDb();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  const r = verdict(db, since);
  db.close();
  const pct = (x) => (x === null ? "no data" : `${(x * 100).toFixed(1)}%`);
  console.log(`database: ${file}`);
  console.log(`M3 baseline (7 days before): ${pct(r.baseline)}`);
  console.log(`M4.5 (7 days after):         ${pct(r.current)}`);
  if (r.delta === null) {
    console.log("verdict: NO DATA (a window has no turns that reported cache reads)");
    process.exit(2);
  }
  console.log(`delta: ${(r.delta * 100).toFixed(1)} pp (trigger: below -5.0 pp)`);
  console.log(`verdict: ${r.pass ? "PASS" : "FAIL: roll back"}`);
  process.exit(r.pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
