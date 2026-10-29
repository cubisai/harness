import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./store";

/** One thread's frozen memory block, tied to the agent session it was first sent to. */
export interface MemorySnapshot {
  sessionKey: string;
  block: string;
  at: number;
  /** The block text the live session has been told about; absent means `block` itself. */
  seen?: string;
}

/**
 * The key a brand-new session's block is stored under until the agent reports
 * its real session id; the first get with that id adopts the block unchanged.
 */
export const PENDING_SESSION = "pending";

/** Thread ids become file names, so they must stay a plain, bounded token. */
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Snapshots older than this are too stale to reuse, even for a still-live thread. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** How many added/removed entries an update note lists before it just counts the rest. */
const UPDATE_CAP = 20;

/** A block's note entries: one markdown list line per fact. */
function entryLines(block: string): string[] {
  return block.split("\n").filter((line) => line.startsWith("- ["));
}

/** One side of an update note, capped so a large memory can't bloat the prompt. */
function side(lines: string[], sign: string): string[] {
  return [...lines.slice(0, UPDATE_CAP).map((l) => `${sign} ${l}`), ...(lines.length > UPDATE_CAP ? [`… ${lines.length - UPDATE_CAP} more`] : [])];
}

/**
 * The frozen memory block each thread was first shown, keyed by thread and tied
 * to the agent session it went to. Keeping it byte-identical for the whole
 * session protects the prompt cache across turns and restarts; a changed
 * session key (or a new thread) recomputes and overwrites.
 */
export class MemorySnapshots {
  constructor(private root: string, private now: () => number = () => Date.now()) {}

  /**
   * The block for this thread's session: the stored one when sessionKey
   * matches, else compute(), store and return it. PENDING_SESSION always
   * computes (a new session); a real key adopts a pending block unchanged.
   */
  get(threadId: string, sessionKey: string, compute: () => string): string {
    if (!THREAD_ID.test(threadId)) return compute();
    const stored = sessionKey === PENDING_SESSION ? null : this.read(threadId);
    if (stored && stored.sessionKey === sessionKey) return stored.block;
    if (stored && stored.sessionKey === PENDING_SESSION) {
      this.write(threadId, { ...stored, sessionKey });
      return stored.block;
    }
    const block = compute();
    this.write(threadId, { sessionKey, block, at: this.now() });
    return block;
  }

  /**
   * What this thread's live session hasn't been told about yet, as a short note,
   * or null when no entry changed (a header-only move counts as unchanged).
   * Consumes the change: the current block becomes the baseline, so a later call
   * returns null until another entry moves.
   */
  updates(threadId: string, current: string): string | null {
    if (!THREAD_ID.test(threadId)) return null;
    const stored = this.read(threadId);
    if (!stored) return null;
    const base = stored.seen ?? stored.block;
    if (current === base) return null;
    const before = entryLines(base);
    const after = entryLines(current);
    const had = new Set(before);
    const has = new Set(after);
    const added = after.filter((l) => !had.has(l));
    const removed = before.filter((l) => !has.has(l));
    if (!added.length && !removed.length) return null;
    this.write(threadId, { ...stored, seen: current });
    return ["<memory-update>", "Memory changed since this session started (the list above is out of date):", ...side(added, "+"), ...side(removed, "-"), "</memory-update>"].join("\n");
  }

  /** Point the current snapshot at a new session key without changing the block (used once the agent reports its real session id). No-op when none stored. */
  rekey(threadId: string, sessionKey: string): void {
    if (!THREAD_ID.test(threadId)) return;
    const stored = this.read(threadId);
    if (!stored) return;
    this.write(threadId, { sessionKey, block: stored.block, at: stored.at });
  }

  /** Forget a thread's snapshot. */
  drop(threadId: string): void {
    if (!THREAD_ID.test(threadId)) return;
    rmSync(this.path(threadId), { force: true });
  }

  /** Remove snapshots of threads not in `live`, and any older than maxAgeMs (default 30 days). Returns how many were removed. */
  prune(live: Set<string>, maxAgeMs: number = MAX_AGE_MS): number {
    let removed = 0;
    for (const name of this.files()) {
      const threadId = name.slice(0, -".json".length);
      const stored = this.read(threadId);
      if (!stored || !live.has(threadId) || this.now() - stored.at > maxAgeMs) {
        rmSync(join(this.dir(), name), { force: true });
        removed++;
      }
    }
    return removed;
  }

  /** The snapshots folder, created on demand. */
  private dir(): string {
    const d = join(this.root, "_snapshots");
    mkdirSync(d, { recursive: true });
    return d;
  }

  private path(threadId: string): string {
    return join(this.dir(), `${threadId}.json`);
  }

  /** The stored snapshot, or null when the file is missing, unreadable or malformed. */
  private read(threadId: string): MemorySnapshot | null {
    const path = this.path(threadId);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MemorySnapshot>;
      if (typeof parsed.sessionKey !== "string" || typeof parsed.block !== "string" || typeof parsed.at !== "number") return null;
      return { sessionKey: parsed.sessionKey, block: parsed.block, at: parsed.at, ...(typeof parsed.seen === "string" ? { seen: parsed.seen } : {}) };
    } catch {
      return null;
    }
  }

  private write(threadId: string, snap: MemorySnapshot): void {
    atomicWrite(this.path(threadId), JSON.stringify(snap));
  }

  /** Every `.json` file name in the folder, empty when it doesn't exist yet. */
  private files(): string[] {
    return readdirSync(this.dir()).filter((f) => f.endsWith(".json"));
  }
}
