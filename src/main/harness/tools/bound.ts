// Bounding what a tool returns to the model: long output is cut, and the whole
// text is saved to a file the model can page through with Read.

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "./types";

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

/** The note bound() leaves where text was omitted; group 3 is the saved file when writing worked. */
export const BOUND_NOTE = /\[(\d+) of (\d+) lines omitted(?:; the full output is in (.+?) \(Read it with offset\/limit, or Grep it\))?\]/;

/** The saved file a bound() note points at, or null when the text wasn't bounded (or nothing was saved). */
export function savedOutputOf(text: string): string | null {
  return BOUND_NOTE.exec(text)?.[3] ?? null;
}

/**
 * The text as the model should see it: unchanged when small, otherwise the head
 * (or tail, for command output where the end matters most) plus where the rest is.
 */
export function bound(text: string, ctx: Pick<ToolContext, "outputDir" | "callId">, keep: "head" | "tail" = "head"): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES && Buffer.byteLength(text) <= MAX_BYTES) return text;
  let kept = keep === "head" ? lines.slice(0, MAX_LINES) : lines.slice(-MAX_LINES);
  let out = kept.join("\n");
  while (Buffer.byteLength(out) > MAX_BYTES && kept.length > 1) {
    kept = keep === "head" ? kept.slice(0, Math.floor(kept.length * 0.8)) : kept.slice(Math.ceil(kept.length * 0.2));
    out = kept.join("\n");
  }
  if (Buffer.byteLength(out) > MAX_BYTES) out = keep === "head" ? out.slice(0, MAX_BYTES) : out.slice(-MAX_BYTES);
  let saved: string | null = null;
  try {
    mkdirSync(ctx.outputDir, { recursive: true });
    saved = join(ctx.outputDir, `${ctx.callId.replace(/[^\w.-]/g, "_")}.txt`);
    writeFileSync(saved, text);
  } catch {
    saved = null;
  }
  const omitted = lines.length - kept.length;
  const note = `[${omitted} of ${lines.length} lines omitted${saved ? `; the full output is in ${saved} (Read it with offset/limit, or Grep it)` : ""}]`;
  return keep === "head" ? `${out}\n\n${note}` : `${note}\n\n${out}`;
}

/**
 * Delete saved-output files older than maxAgeMs. A missing folder and per-file
 * errors are ignored (a file another turn is still paging through may be busy).
 * Returns how many were removed.
 */
export function pruneOutputDir(dir: string, maxAgeMs = 14 * 24 * 3600 * 1000, now = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".txt")) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile() || now - st.mtimeMs <= maxAgeMs) continue;
      unlinkSync(path);
      removed++;
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return removed;
}
