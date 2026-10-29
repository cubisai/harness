// P1.8 desktop baseline fixtures: a seeded generator for large thread histories
// and a Store seeder, so the P2 paging/windowing work has a reproducible
// before/after baseline. No Math.random and no Date.now in the generated
// content: the same HistorySpec always yields byte-identical events.

import type { Store } from "../src/main/db";
import type { ThreadEvent } from "../src/shared/types";

/** mulberry32: a tiny seeded PRNG (the one in scripts/mock-extensions-lib.mjs). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HistorySpec {
  events: number;
  seed: number;
  subagents?: boolean;
}

export const PRESETS = {
  small: { events: 200, seed: 1 },
  long: { events: 10_000, seed: 2, subagents: true },
  huge: { events: 50_000, seed: 3, subagents: true },
} as const;

const TOOLS = ["Read", "Edit", "Bash", "Grep"] as const;

/** A one-line tool summary shaped like the real ones: a path or a command. */
function summaryFor(name: string, rand: () => number): string {
  const n = Math.floor(rand() * 90) + 1;
  if (name === "Bash") return `bun run step-${n} --flag=${Math.floor(rand() * 9)}`;
  if (name === "Grep") return `listEvents in src/main/file-${n}.ts: ${Math.floor(rand() * 20)} matches`;
  return `src/module-${n}/file-${Math.floor(rand() * 40)}.ts`;
}

/** A deterministic 2–20 KB string payload, so the JSON.parse proxy sees real bytes. */
function filler(rand: () => number): string {
  const bytes = (2 + Math.floor(rand() * 19)) * 1024;
  const line = `payload ${Math.floor(rand() * 1e6).toString(36)} — the quick brown fox jumps over the lazy dog.\n`;
  return line.repeat(Math.ceil(bytes / line.length));
}

function rootTurnEnd(rand: () => number, steps: number): ThreadEvent {
  const inputTokens = Math.floor(rand() * 5000);
  const outputTokens = Math.floor(rand() * 2000);
  const cacheReadTokens = Math.floor(rand() * 40000);
  const total = inputTokens + cacheReadTokens;
  return {
    kind: "turn-end",
    costUsd: Number((rand() * 0.5).toFixed(4)),
    inputTokens,
    outputTokens,
    durationMs: Math.floor(rand() * 60_000),
    steps,
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens: null,
      cacheReadTokens,
      cacheWriteTokens: null,
      cacheTtl: "5m",
      hitRate: total ? cacheReadTokens / total : null,
      miss: false,
      provenance: "reported",
      contextUsed: total,
      contextSize: 200_000,
    },
  };
}

function childTurnEnd(rand: () => number, parentId: string): ThreadEvent {
  return {
    kind: "turn-end",
    costUsd: Number((rand() * 0.05).toFixed(4)),
    inputTokens: Math.floor(rand() * 800),
    outputTokens: Math.floor(rand() * 400),
    durationMs: Math.floor(rand() * 5000),
    parentId,
  };
}

/** One turn: turn-start, user, a run of work (~40 events), then turn-end. */
function makeTurn(rand: () => number, n: number, subagents: boolean): ThreadEvent[] {
  const turnId = `turn-${n}`;
  const events: ThreadEvent[] = [
    { kind: "turn-start", turnId, agent: "eval", model: "m" },
    { kind: "user", text: `Turn ${n}: work through the fixture task.` },
  ];
  const steps = 6 + Math.floor(rand() * 6);
  for (let s = 0; s < steps; s++) {
    if (rand() < 0.8) events.push({ kind: "assistant-text", text: `Working on step ${s} of turn ${n}.` });
    if (rand() < 0.7) events.push({ kind: "thinking", text: `Considering step ${s} before acting.` });
    const name = TOOLS[Math.floor(rand() * TOOLS.length)]!;
    const toolUseId = `u-${n}-${s}`;
    events.push({ kind: "tool-use", toolUseId, name, summary: summaryFor(name, rand) });
    const isError = rand() < 0.1;
    const base = summaryFor(name, rand);
    const summary = name === "Edit" ? `${base} +${Math.floor(rand() * 40)} −${Math.floor(rand() * 8)}` : base;
    // ~10% error results; ~30% carry a 2–20 KB payload.
    if (rand() < 0.3) events.push({ kind: "tool-result", toolUseId, isError, summary, payload: filler(rand) });
    else events.push({ kind: "tool-result", toolUseId, isError, summary });
    // A reasoning summary is a live delta, so it persists as thinking.
    if (rand() < 0.3) events.push({ kind: "thinking", text: `Reasoned about step ${s}.`, opaque: true });
    if (rand() < 0.1) events.push({ kind: "notice", text: `Note at step ${s} of turn ${n}.` });
  }
  if (subagents && rand() < 0.15) {
    // A child's parentId is the root task call that spawned it, as in the native harness.
    const parentId = `sub-${n}`;
    events.push({ kind: "tool-use", toolUseId: parentId, name: "task", summary: "Check the shared types" });
    events.push({ kind: "tool-use", toolUseId: `u-${n}-sub`, name: "Read", summary: "src/shared/types.ts", parentId });
    events.push({ kind: "tool-result", toolUseId: `u-${n}-sub`, isError: false, summary: "src/shared/types.ts", parentId });
    events.push({ kind: "assistant-text", text: `Subagent ${parentId} reported back.`, parentId });
    events.push(childTurnEnd(rand, parentId));
    events.push({ kind: "tool-result", toolUseId: parentId, isError: false, summary: "The shared types are consistent." });
  }
  events.push(rootTurnEnd(rand, steps));
  return events;
}

/** Exactly `spec.events` events, whole turns except a possibly truncated last one. */
export function makeHistory(spec: HistorySpec): ThreadEvent[] {
  const rand = mulberry32(spec.seed);
  const events: ThreadEvent[] = [];
  for (let n = 0; events.length < spec.events; n++) events.push(...makeTurn(rand, n, spec.subagents ?? false));
  events.length = spec.events; // cut the last turn short
  return events;
}

/** The big thread under `/fixtures/p0`, plus optional extra projects of small threads. */
export function seedStore(store: Store, spec: HistorySpec, o?: { projects?: number; threadsPerProject?: number }): { projectId: string; threadId: string } {
  const project = store.addProject("/fixtures/p0");
  const thread = store.createThread(project.id, "eval", "m", "ask");
  // Store exposes no transaction, so append plainly.
  for (const event of makeHistory(spec)) store.appendEvent(thread.id, event);

  const projects = o?.projects ?? 0;
  const threadsPerProject = o?.threadsPerProject ?? 0;
  for (let i = 0; i < projects; i++) {
    const extra = store.addProject(`/fixtures/p${i + 1}`);
    for (let j = 0; j < threadsPerProject; j++) {
      const seed = spec.seed * 100_000 + i * 1000 + j;
      const events = 20 + Math.floor(mulberry32(seed)() * 41); // 20–60 events
      const small = store.createThread(extra.id, "eval", "m", "ask");
      for (const event of makeHistory({ events, seed })) store.appendEvent(small.id, event);
      if (j % 3 === 2) store.updateThread(small.id, { archived: true });
    }
  }
  return { projectId: project.id, threadId: thread.id };
}
