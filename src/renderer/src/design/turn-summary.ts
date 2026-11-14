/**
 * What a design turn left behind, for its card in the chat: the page version it wrote, how many lines that version
 * added and removed, and which kit parts the page is built from (with the ones this turn brought in marked new).
 * Pure, so the card only fetches and draws.
 */
import type { ArtifactVersion } from "../../../shared/types";

/** The version a turn wrote, and the one before it. Hand edits after a turn record under the same turn, so it's the first. */
export function turnVersion(versions: readonly ArtifactVersion[], turnSeq: number): { version: number; previous: number | null } | null {
  const mine = versions.filter((v) => v.turnSeq === turnSeq).map((v) => v.version);
  if (!mine.length) return null;
  const version = Math.min(...mine);
  const earlier = versions.filter((v) => v.version < version).map((v) => v.version);
  return { version, previous: earlier.length ? Math.max(...earlier) : null };
}

/** Lines added and removed between two texts, counted as a multiset (a moved line is neither). No `before`: all added. */
export function lineDelta(before: string | null, after: string): { added: number; removed: number } {
  const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const left = new Map<string, number>();
  for (const l of before === null ? [] : lines(before)) left.set(l, (left.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of lines(after)) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of left.values()) removed += n;
  return { added, removed };
}

/** Each `data-ui` part in a page with how often it appears, in order of first appearance. */
export function partCounts(html: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/\sdata-ui\s*=\s*["']?([a-z0-9-]+)/gi)) {
    const ui = m[1]!.toLowerCase();
    counts.set(ui, (counts.get(ui) ?? 0) + 1);
  }
  return counts;
}

export interface TurnPart {
  ui: string;
  name: string;
  count: number;
  /** Not on the page before this turn. */
  fresh: boolean;
}

/** The parts the page is built from after the turn. `names` maps a part to its kit name; others get a title-cased id. */
export function turnParts(before: string | null, after: string, names: Readonly<Record<string, string>>): TurnPart[] {
  const had = before === null ? new Map<string, number>() : partCounts(before);
  return [...partCounts(after)].map(([ui, count]) => ({ ui, name: names[ui] ?? ui.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => `${dash ? " " : ""}${c.toUpperCase()}`), count, fresh: !had.has(ui) }));
}

/** The card's title: `Built from MUI · 6 reused · 2 new`, or `Built from MUI · 6 parts` for a first page. */
export function turnTitle(parts: readonly TurnPart[], kit: string | null, firstVersion: boolean): string {
  const from = `Built from ${kit ?? "your kit"}`;
  if (firstVersion) return `${from} · ${parts.length} part${parts.length === 1 ? "" : "s"}`;
  const fresh = parts.filter((p) => p.fresh).length;
  const reused = parts.length - fresh;
  return [from, `${reused} reused`, ...(fresh ? [`${fresh} new`] : [])].join(" · ");
}
