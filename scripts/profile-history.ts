// P1.8 history profiling: seeds the deterministic fixtures into a temp SQLite
// store and times the reads P2's paging/windowing work will change, so it has a
// reproducible before/after baseline.
//
//   bun scripts/profile-history.ts [--preset small|long|huge|all] [--runs N] [--json out.json]
//
// Defaults: preset all, 5 runs. Save a baseline under .ai/profiles/ by convention:
//
//   bun scripts/profile-history.ts --preset all --runs 3 --json .ai/profiles/history-<date>.json
//
// Re-run the identical command after P2 and diff the two JSON files.
//
// Metrics: listEvents (cold = first read after reopening the store, warm = the
// rest), listThreads for every project, segmentEvents (the renderer projection),
// and an event-size/JSON.parse proxy. heapUsed/rss are recorded for the huge
// preset. If the renderer projection can't load under this runtime, that metric
// is skipped and reported instead of failing the run.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../src/main/db";
import { PRESETS, seedStore } from "./history-fixtures";
import type { HistorySpec } from "./history-fixtures";
import type { StoredEvent } from "../src/shared/types";

interface Row {
  preset: string;
  events: number;
  metric: string;
  coldMs: number | null;
  warmP50Ms: number | null;
  warmP95Ms: number | null;
  bytes: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/** `samples[0]` is the cold run after reopening; the rest are warm. */
function summarize(preset: string, events: number, metric: string, samples: number[], bytes = 0): Row {
  const warm = samples.slice(1).sort((a, b) => a - b);
  return { preset, events, metric, coldMs: samples[0] ?? null, warmP50Ms: percentile(warm, 0.5), warmP95Ms: percentile(warm, 0.95), bytes };
}

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const presetArg = arg("--preset") ?? "all";
if (presetArg !== "all" && !(presetArg in PRESETS)) {
  console.error("usage: bun scripts/profile-history.ts [--preset small|long|huge|all] [--runs N] [--json out.json]");
  process.exit(2);
}
const names = (presetArg === "all" ? Object.keys(PRESETS) : [presetArg]) as (keyof typeof PRESETS)[];
const runs = Math.max(1, Number(arg("--runs") ?? 5));
const jsonPath = arg("--json");

type SegmentFn = (events: StoredEvent[], running: boolean) => unknown;
let segment: SegmentFn | null = null;
try {
  const turns = await import("../src/renderer/src/turns");
  segment = turns.segmentEvents as SegmentFn;
} catch (err) {
  console.warn(`segmentEvents unavailable under this runtime (${(err as Error).message}); skipping that metric`);
}

const results: Row[] = [];
const seeds: Record<string, number> = {};
let memory: { heapUsed: number; rss: number } | null = null;

for (const name of names) {
  const spec = PRESETS[name] as HistorySpec;
  const dir = mkdtempSync(join(tmpdir(), "history-profile-"));
  const file = join(dir, "t.db");
  let store: Store | null = new Store(file);
  try {
    const seedStart = performance.now();
    const { threadId } = seedStore(store, spec, { projects: 20, threadsPerProject: 25 });
    seeds[name] = performance.now() - seedStart;

    // The first read after reopening is the cold one.
    store.close();
    store = new Store(file);
    const projects = store.listProjects().map((p) => p.id);

    const listEventsSamples: number[] = [];
    const listThreadsSamples: number[] = [];
    const segmentSamples: number[] = [];
    let events: StoredEvent[] = [];
    let bytes = 0;
    for (let r = 0; r < runs; r++) {
      let t = performance.now();
      events = store.listEvents(threadId);
      listEventsSamples.push(performance.now() - t);
      if (r === 0) bytes = events.reduce((n, e) => n + JSON.stringify(e.event).length, 0);

      t = performance.now();
      for (const pid of projects) store.listThreads(pid);
      listThreadsSamples.push(performance.now() - t);

      if (segment) {
        t = performance.now();
        segment(events, false);
        segmentSamples.push(performance.now() - t);
      }
    }
    if (name === "huge") {
      const m = process.memoryUsage();
      memory = { heapUsed: m.heapUsed, rss: m.rss };
    }

    results.push(summarize(name, spec.events, "listEvents", listEventsSamples, bytes));
    results.push(summarize(name, spec.events, "listThreads", listThreadsSamples));
    if (segment) results.push(summarize(name, spec.events, "segmentEvents", segmentSamples));
    results.push({ preset: name, events: spec.events, metric: "eventBytes", coldMs: null, warmP50Ms: null, warmP95Ms: null, bytes });
  } finally {
    try {
      store?.close();
    } catch {
      // Already closed.
    }
    // Bun's node:sqlite holds the file handles until the connection is collected;
    // drop the reference and force a GC so the temp dir can be removed on Windows.
    store = null;
    (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun?.gc?.(true);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
const ms = (v: number | null): string => (v === null ? "—" : v.toFixed(2));
for (const [name, value] of Object.entries(seeds)) console.log(`seed ${name}: ${value.toFixed(1)} ms`);
console.log(`${pad("preset", 8)} ${pad("events", 8)} ${pad("metric", 14)} ${pad("cold ms", 10)} ${pad("warm p50", 10)} ${pad("warm p95", 10)} ${pad("bytes", 12)}`);
for (const r of results) {
  console.log(`${pad(r.preset, 8)} ${pad(String(r.events), 8)} ${pad(r.metric, 14)} ${pad(ms(r.coldMs), 10)} ${pad(ms(r.warmP50Ms), 10)} ${pad(ms(r.warmP95Ms), 10)} ${pad(String(r.bytes), 12)}`);
}

if (jsonPath) {
  const payload = {
    platform: process.platform,
    arch: process.arch,
    bun: process.versions.bun ?? null,
    cpu: cpus()[0]?.model ?? null,
    date: new Date().toISOString(),
    seeds,
    memory,
    results,
  };
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  console.log(`wrote ${jsonPath}`);
}
