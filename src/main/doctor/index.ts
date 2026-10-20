// /doctor in the main process: gather the machine snapshot, run the pure
// checks, and apply a fix the user clicked. A fix is looked up by finding id
// and index in the last report the app produced, so the renderer can never
// name a command for the app to run.

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { DoctorFixResult, DoctorReport } from "../../shared/doctor";
import { newestInstallAsync, setBinaryPins } from "../agents/binaries";
import { bundledClaudeVersion } from "../agents/claude";
import { findPython } from "../guard";
import { runChecks } from "./checks";
import { gatherSnapshot, type GatherDeps } from "./gather";

const run = promisify(execFile);

export interface DoctorDeps {
  agents: () => GatherDeps["agents"];
  pinned: () => Record<string, string>;
  /** Save a pin (agent id → path); null removes it. */
  savePin: (agent: string, path: string | null) => void;
  worktreesDir: string | null;
  liveWorktreeIds: () => Set<string>;
}

export interface Doctor {
  run(): Promise<DoctorReport>;
  fix(findingId: string, fixIndex: number): Promise<DoctorFixResult>;
}

/** A command's output, or null when it can't run. */
async function versionOf(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(command, args, { timeout: 15_000, windowsHide: true });
    return `${stdout}\n${stderr}`;
  } catch {
    return null;
  }
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const listDirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

/** The QuickJS sandbox code mode runs in loads on this build. */
async function quickjsLoads(): Promise<boolean> {
  try {
    const { getQuickJS } = await import("quickjs-emscripten");
    await getQuickJS();
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a leftover worktree folder only when git says it's a clean worktree
 * (`git worktree remove` refuses a dirty one); an empty plain folder goes too.
 * Anything else is kept and reported.
 */
async function pruneWorktree(dir: string): Promise<boolean> {
  try {
    const common = (await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir })).stdout.trim();
    if (!isAbsolute(common)) return false;
    await run("git", ["worktree", "remove", dir], { cwd: dirname(common) });
    await run("git", ["worktree", "prune"], { cwd: dirname(common) }).catch(() => undefined);
    return true;
  } catch {
    try {
      if (readdirSync(dir).length === 0) {
        rmdirSync(dir);
        return true;
      }
    } catch {
      // Gone already, or unreadable: keep it.
    }
    return false;
  }
}

export function createDoctor(d: DoctorDeps): Doctor {
  let last: DoctorReport | null = null;
  return {
    async run() {
      const snapshot = await gatherSnapshot({
        platform: process.platform,
        env: process.env,
        agents: d.agents(),
        pinned: d.pinned(),
        newestInstall: (command) => newestInstallAsync(command),
        runVersion: versionOf,
        findPython,
        bundledClaudeVersion,
        readText,
        listDirs,
        worktreesDir: d.worktreesDir,
        liveWorktreeIds: d.liveWorktreeIds(),
        quickjsLoads,
        homedir: homedir(),
        realpath: (path) => {
          try {
            return realpathSync(path);
          } catch {
            return path;
          }
        },
      });
      last = { at: Date.now(), findings: runChecks(snapshot) };
      return last;
    },
    async fix(findingId, fixIndex) {
      const fix = last?.findings.find((f) => f.id === findingId)?.fixes[fixIndex];
      if (!fix) return { ok: false, message: "That fix isn't in the latest report. Run /doctor again." };
      switch (fix.kind) {
        case "copy":
          return { ok: true, message: "Copied." };
        case "pin": {
          const agent = d.agents().find((a) => a.id === fix.agent);
          d.savePin(fix.agent, fix.path);
          setBinaryPins(pinsByCommand(d));
          return { ok: true, message: `${agent?.label ?? fix.agent} now uses ${fix.path ?? "the newest install"}. New threads pick it up.` };
        }
        case "run": {
          try {
            const { stdout, stderr } = await run(fix.command, fix.args, { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
            return { ok: true, message: lastLine(`${stdout}\n${stderr}`) || `${fix.label}: done.` };
          } catch (err) {
            const e = err as { stderr?: string; message?: string };
            return { ok: false, message: lastLine(e.stderr ?? "") || (e.message ?? "The command failed.").split("\n")[0]! };
          }
        }
        case "prune-worktrees": {
          let removed = 0;
          for (const dir of fix.dirs) if (await pruneWorktree(dir)) removed++;
          const kept = fix.dirs.length - removed;
          return { ok: kept === 0, message: kept ? `Removed ${removed}; kept ${kept} with uncommitted work or not a git worktree.` : `Removed ${removed}.` };
        }
      }
    },
  };
}

/** Pins keyed by CLI command, as the binary resolver wants them. */
export function pinsByCommand(d: Pick<DoctorDeps, "agents" | "pinned">): Record<string, string> {
  const out: Record<string, string> = {};
  const pinned = d.pinned();
  for (const agent of d.agents()) if (pinned[agent.id]) out[agent.command] = pinned[agent.id]!;
  return out;
}

const lastLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 300) ?? "";
