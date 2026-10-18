import type { MemoryStore } from "./store";

/** Lowercased alphanumeric words of at least `min` characters. */
export function wordSet(text: string, min: number): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= min));
}

/** How much two notes' titles+descriptions overlap, 0..1 (0 when both are empty). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * The scope's note a new one would duplicate: a same-name (case-insensitive)
 * note first, else the first whose title+description overlaps by 0.7 or more.
 */
export function findDuplicate(store: MemoryStore, scope: string, name: string, description: string): { file: string; kind: "same" | "near" } | null {
  const existing = store.list(scope);
  const trimmed = name.trim();
  const same = existing.find((f) => f.name.toLowerCase() === trimmed.toLowerCase());
  if (same) return { file: same.file, kind: "same" };
  const candidate = wordSet(`${trimmed} ${description}`, 3);
  const near = existing.find((f) => jaccard(candidate, wordSet(`${f.name} ${f.description}`, 3)) >= 0.7);
  return near ? { file: near.file, kind: "near" } : null;
}
