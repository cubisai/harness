import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** The most bytes one snapshot may hold: a bigger folder is left alone, so a turn never copies a huge tree. */
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * Keeps a design thread's managed `system/` folder as it was when the agent's
 * turn started, then undoes what the turn changed there. The agent's own file
 * tools are fenced out of `system/`, but a shell command could still write it.
 * CubiQ's own writes (a theme switch, a direction change) call {@link refresh}
 * to make them the new baseline. Every method is synchronous and never throws.
 */
export class SystemGuard {
  private snaps = new Map<string, Map<string, Buffer> | "skip">();
  /** Per guarded folder, what {@link settle} already undid this turn, for the report at {@link end}. */
  private undone = new Map<string, Set<string>>();

  /** Snapshot every regular file under `dir` as the baseline for the turn; a missing folder is an empty one. */
  begin(dir: string): void {
    this.undone.delete(dir);
    try {
      this.snaps.set(dir, this.capture(dir) ?? "skip");
    } catch {
      this.snaps.set(dir, "skip");
    }
  }

  /** Re-take the baseline for a guarded `dir` (CubiQ just wrote it); an unguarded folder is left untouched. */
  refresh(dir: string): void {
    if (!this.snaps.has(dir)) return;
    try {
      this.snaps.set(dir, this.capture(dir) ?? "skip");
    } catch {
      this.snaps.set(dir, "skip");
    }
  }

  /**
   * Undo what the turn changed under a guarded `dir` so far, and keep guarding it. CubiQ calls this right before it
   * writes the folder itself, then {@link refresh} after, so its write never adopts an earlier shell write as its own.
   */
  settle(dir: string): void {
    const snap = this.snaps.get(dir);
    if (!snap || snap === "skip") return;
    const rels = this.restore(dir, snap);
    if (rels.length === 0) return;
    const seen = this.undone.get(dir) ?? new Set<string>();
    for (const rel of rels) seen.add(rel);
    this.undone.set(dir, seen);
  }

  /**
   * Undo every change under `dir` since its baseline: added files are removed,
   * and missing or rewritten files are written back. Returns the sorted relative
   * paths it changed this turn (with what {@link settle} undid), so the caller can tell the user and the agent.
   */
  end(dir: string): string[] {
    const snap = this.snaps.get(dir);
    const earlier = this.undone.get(dir) ?? new Set<string>();
    this.snaps.delete(dir);
    this.undone.delete(dir);
    if (!snap || snap === "skip") return [];
    return [...new Set([...earlier, ...this.restore(dir, snap)])].sort();
  }

  /** Put `dir` back to `snap`; returns the relative paths it removed or wrote back. */
  private restore(dir: string, snap: Map<string, Buffer>): string[] {
    let current: Map<string, Buffer> | null = null;
    try {
      current = this.capture(dir);
    } catch {
      // A folder that can't be read changes nothing.
    }
    if (!current) return [];
    const changed: string[] = [];
    for (const rel of current.keys()) {
      if (snap.has(rel)) continue;
      try {
        rmSync(join(dir, rel), { force: true });
        changed.push(rel);
      } catch {
        // A file that can't be removed stays.
      }
    }
    for (const [rel, bytes] of snap) {
      const now = current.get(rel);
      if (now && now.equals(bytes)) continue;
      try {
        const file = join(dir, rel);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
        changed.push(rel);
      } catch {
        // A file that can't be written back stays as it is.
      }
    }
    return changed;
  }

  /** Every regular file under `dir` by `/`-separated relative path, or null when the total is past MAX_BYTES. */
  private capture(dir: string): Map<string, Buffer> | null {
    const files: { rel: string; file: string }[] = [];
    let total = 0;
    const walk = (current: string): void => {
      try {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const file = join(current, entry.name);
          if (entry.isDirectory()) {
            walk(file);
            continue;
          }
          // Symlinks and special files are skipped: a snapshot only holds real bytes in the folder.
          if (!entry.isFile()) continue;
          try {
            total += statSync(file).size;
          } catch {
            continue;
          }
          files.push({ rel: relative(dir, file).replace(/\\/g, "/"), file });
        }
      } catch {
        // A missing or unreadable folder holds no files.
      }
    };
    walk(dir);
    if (total > MAX_BYTES) return null;
    const snap = new Map<string, Buffer>();
    for (const { rel, file } of files) {
      try {
        snap.set(rel, readFileSync(file));
      } catch {
        // Gone since the directory was read: it has nothing to restore.
      }
    }
    return snap;
  }
}
