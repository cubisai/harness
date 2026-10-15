// The working tree as it was before a turn, for the revert signal (S1) and the
// captured eval case (S3): HEAD's commit plus the bytes of every path that
// differed from it. Bounded, so a huge dirty tree costs a capped read.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { dirtyPaths, hasGitDir } from "../git";

const run = promisify(execFile);

export const SNAPSHOT_CAP = { files: 200, fileBytes: 256 * 1024, totalBytes: 4 * 1024 * 1024 };

export interface PreTurn {
  /** HEAD's commit, or null outside git / before the first commit. */
  headSha: string | null;
  /** Each path that differed from HEAD: its bytes, or null when it was deleted. */
  overlay: Map<string, Buffer | null>;
  /** False when a cap cut the overlay short: the tree can't be rebuilt from it. */
  complete: boolean;
  at: number;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A file's bytes at HEAD, or null when it isn't tracked there. */
export async function headBytes(cwd: string, rel: string): Promise<Buffer | null> {
  try {
    const out = await run("git", ["show", `HEAD:./${rel.replace(/\\/g, "/")}`], { cwd, encoding: "buffer", maxBuffer: SNAPSHOT_CAP.fileBytes * 4 });
    return out.stdout as unknown as Buffer;
  } catch {
    return null;
  }
}

/** A working-tree file's bytes, or null when it's missing, a folder, or over the per-file cap. */
export function fileBytes(cwd: string, rel: string): Buffer | null | "too-big" {
  const full = join(cwd, rel);
  try {
    if (!existsSync(full)) return null;
    const st = statSync(full);
    if (!st.isFile()) return null;
    if (st.size > SNAPSHOT_CAP.fileBytes) return "too-big";
    return readFileSync(full);
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Snapshot the tree before a turn; null outside a git repository. Never throws. */
export async function snapshotPre(cwd: string, now: () => number = () => Date.now()): Promise<PreTurn | null> {
  try {
    if (!hasGitDir(cwd)) return null;
    let headSha: string | null = null;
    try {
      headSha = (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim() || null;
    } catch {
      headSha = null;
    }
    const overlay = new Map<string, Buffer | null>();
    let complete = true;
    let total = 0;
    const paths = (await dirtyPaths(cwd)).map((p) => p.replace(/\/$/, ""));
    for (const rel of paths) {
      if (overlay.size >= SNAPSHOT_CAP.files) {
        complete = false;
        break;
      }
      // git lists an untracked folder as one entry; its files aren't read one by one.
      if (isDir(join(cwd, rel))) {
        complete = false;
        continue;
      }
      const bytes = fileBytes(cwd, rel);
      if (bytes === "too-big") {
        complete = false;
        continue;
      }
      if (bytes && total + bytes.length > SNAPSHOT_CAP.totalBytes) {
        complete = false;
        break;
      }
      total += bytes?.length ?? 0;
      overlay.set(rel, bytes);
    }
    return { headSha, overlay, complete, at: now() };
  } catch {
    return null;
  }
}

/** A path's bytes before the turn: the overlay's when it was dirty, else HEAD's (null = it didn't exist). */
export async function preBytes(cwd: string, pre: PreTurn, rel: string): Promise<Buffer | null> {
  if (pre.overlay.has(rel)) return pre.overlay.get(rel) ?? null;
  return pre.headSha ? headBytes(cwd, rel) : null;
}
