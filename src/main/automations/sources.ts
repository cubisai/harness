// What an automation reads from: the built-in git source (commit log).

import { execCommandSync } from "../winspawn";
import type { Source } from "./io";

/** The git invocation the source narrows to; tests inject a fake instead of a shell. */
export type GitExec = (command: string, args: string[], opts: { cwd: string }) => string;

/** First run reads this many commits; an incremental read allows more. */
const FIRST_RUN = 20;
const INCREMENTAL = 50;

/** The original command's message, appended when it is short enough to belong in the error. */
function reason(err: unknown): string {
  const line = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim();
  return line && line.length <= 200 ? ` — ${line}` : "";
}

function parseLog(out: string): string[] {
  const items: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const sha = tab === -1 ? line : line.slice(0, tab);
    items.push(`${sha.slice(0, 7)} ${tab === -1 ? "" : line.slice(tab + 1)}`);
  }
  return items;
}

/**
 * Read `git log` since a bookmark (the last delivered HEAD). A first run (null
 * bookmark) reads the last FIRST_RUN commits on HEAD; an incremental run reads
 * `bookmark..HEAD`. A bookmark that no longer exists — after a rebase — reads
 * like a first run. An unreachable repo throws; it never reads as "nothing new".
 */
export function gitLogSource(exec: GitExec = execCommandSync): Source {
  return {
    id: "git",
    async read(bookmark, { cwd }) {
      let head: string;
      try {
        head = exec("git", ["rev-parse", "HEAD"], { cwd }).trim();
      } catch (err) {
        throw new Error(`not a git repository: ${cwd}${reason(err)}`);
      }
      if (bookmark === head) return { items: [], next: null };

      const format = ["log", "--format=%H%x09%s", "-n"];
      let out: string;
      if (bookmark) {
        try {
          out = exec("git", [...format, String(INCREMENTAL), `${bookmark}..HEAD`], { cwd });
        } catch {
          // The bookmark can be gone after a rewritten history; read like a first run.
          out = exec("git", [...format, String(FIRST_RUN), "HEAD"], { cwd });
        }
      } else {
        out = exec("git", [...format, String(FIRST_RUN), "HEAD"], { cwd });
      }
      return { items: parseLog(out), next: head };
    },
  };
}

/** The sources an automation can be configured with, keyed by id. */
export function defaultSources(): Map<string, Source> {
  const git = gitLogSource();
  return new Map([[git.id, git]]);
}
