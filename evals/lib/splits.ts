// Dataset splits (roadmap P8.1): train/validation/holdout assignment, the sealed
// holdout and the leakage checks. A task's split is a stable hash of its family,
// so variants of one scenario (route-skill-1, route-skill-2, …) never straddle
// train and holdout. Plans: .ai/plans/eval-framework.md.

import { createHash } from "node:crypto";
import type { Split, Task } from "./types";

/** Target share of the tasks in each split; the hash makes them approximate. */
export const SPLIT_SHARES = { train: 0.6, validation: 0.2, holdout: 0.2 };

/**
 * Ids that are variants of one scenario share a family, so they always land in
 * the same split. Keep only near-duplicate groups here; unrelated tasks follow
 * their own id. See evals/tasks/*.json for the prompts.
 */
const KNOWN_FAMILIES: Record<string, string> = {
  "route-skill-1": "route-skill",
  "route-skill-2": "route-skill",
  "route-skill-3": "route-skill",
  "route-none-1": "route-none",
  "route-none-2": "route-none",
  "route-ambiguous-1": "route-ambiguous",
  "route-ambiguous-2": "route-ambiguous",
  "mcp-lookup": "mcp-status",
  "x-mcp-ambiguous": "mcp-status",
  "x-mcp-unavailable": "mcp-status",
  "explain-no-edit": "explain-sum",
  "x-memory-irrelevant": "explain-sum",
  "agents-md-rules": "clamp-math",
  "x-memory-preference": "clamp-math",
};

/** The scenario a task belongs to: its explicit family, a known variant group, or its own id. */
export function familyOf(t: Task): string {
  return t.family ?? KNOWN_FAMILIES[t.id] ?? t.id;
}

/** Stable split for a task: its explicit pin, else sha256(seed:family) mapped through the shares. */
export function splitOf(t: Task, seed = "v1"): Split {
  if (t.split) return t.split;
  const hash = createHash("sha256").update(`${seed}:${familyOf(t)}`).digest("hex").slice(0, 8);
  const unit = parseInt(hash, 16) / 0xffffffff;
  if (unit < SPLIT_SHARES.train) return "train";
  if (unit < SPLIT_SHARES.train + SPLIT_SHARES.validation) return "validation";
  return "holdout";
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a: Task, b: Task): number => cmp(a.id, b.id);

/**
 * Every task's split. A family shares one split; when conflicting explicit pins
 * disagree, the whole family takes the first task's split by id order (the
 * conflict is reported by checkSplits).
 */
export function assignSplits(tasks: Task[], seed = "v1"): Map<string, Split> {
  const out = new Map<string, Split>();
  const familySplit = new Map<string, Split>();
  for (const t of [...tasks].sort(byId)) {
    const family = familyOf(t);
    const known = familySplit.get(family);
    if (known !== undefined) {
      out.set(t.id, known);
      continue;
    }
    const split = splitOf(t, seed);
    familySplit.set(family, split);
    out.set(t.id, split);
  }
  return out;
}

export interface LeakProblem {
  kind: "family-conflict" | "near-duplicate";
  tasks: [string, string];
  detail: string;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "you", "are", "was", "were",
  "has", "have", "not", "but", "all", "any", "can", "its", "then", "than", "when", "what", "which",
  "will", "should", "would", "could", "make", "keep", "use", "using", "file", "files",
]);

/** Lowercased words (letters/digits, ≥3 chars) of the prompt and every follow-up, minus stopwords. */
export function promptWords(t: Task): Set<string> {
  const text = [t.prompt, ...(t.turns?.map((turn) => turn.prompt) ?? [])].join(" ");
  const words = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 3 && !STOPWORDS.has(word)) words.add(word);
  }
  return words;
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B|. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Leakage across splits: a family whose explicit pins disagree, or a pair of
 * tasks in different splits that is too similar (near-identical prompts, or
 * prompts on the same fixture that are merely close). Sorted by task ids.
 */
export function checkSplits(tasks: Task[], opts: { seed?: string; threshold?: number } = {}): LeakProblem[] {
  const threshold = opts.threshold ?? 0.6;
  const sorted = [...tasks].sort(byId);
  const splits = assignSplits(tasks, opts.seed);
  const problems: LeakProblem[] = [];

  const pinnedFamily = new Map<string, { id: string; split: Split }>();
  for (const t of sorted) {
    if (!t.split) continue;
    const family = familyOf(t);
    const first = pinnedFamily.get(family);
    if (!first) pinnedFamily.set(family, { id: t.id, split: t.split });
    else if (first.split !== t.split) problems.push({ kind: "family-conflict", tasks: [first.id, t.id], detail: `${family} pinned to both "${first.split}" and "${t.split}"` });
  }

  const words = new Map(sorted.map((t) => [t.id, promptWords(t)] as const));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (splits.get(a.id) === splits.get(b.id)) continue;
      const sim = similarity(words.get(a.id)!, words.get(b.id)!);
      const sameFixture = a.fixture === b.fixture;
      if (sim >= (sameFixture ? threshold - 0.2 : threshold)) {
        problems.push({ kind: "near-duplicate", tasks: [a.id, b.id], detail: `similarity ${sim.toFixed(2)}${sameFixture ? ", same fixture" : ""}` });
      }
    }
  }
  return problems.sort((a, b) => cmp(a.tasks[0], b.tasks[0]) || cmp(a.tasks[1], b.tasks[1]));
}

/** The tasks in one split. The holdout is sealed unless `sealed: false` says this is a release decision. */
export function forSplit(tasks: Task[], split: Split, opts: { seed?: string; sealed?: boolean } = {}): Task[] {
  if (split === "holdout" && opts.sealed !== false) {
    throw new Error("The holdout split is sealed: run it with --split holdout --release (for a release decision), never while drafting changes.");
  }
  const splits = assignSplits(tasks, opts.seed);
  return tasks.filter((t) => splits.get(t.id) === split).sort(byId);
}

/** "train N · validation N · holdout N" plus one line per split listing its task ids. */
export function splitSummary(tasks: Task[], seed?: string): string {
  const splits = assignSplits(tasks, seed);
  const order: Split[] = ["train", "validation", "holdout"];
  const inSplit = (s: Split): Task[] => tasks.filter((t) => splits.get(t.id) === s).sort(byId);
  return [
    order.map((s) => `${s} ${inSplit(s).length}`).join(" · "),
    ...order.map((s) => `${s}: ${inSplit(s).map((t) => t.id).join(", ")}`),
  ].join("\n");
}
