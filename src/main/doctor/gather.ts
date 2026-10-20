// Gathers the machine snapshot that the doctor's pure core (checks.ts) reads.
// Every probe comes in through GatherDeps, so the gather stays testable with
// fakes and this file itself never spawns, reads or writes anything.

import { join, win32 } from "node:path";
import type { AgentInstall, AgentSnapshot, DoctorSnapshot } from "./checks";

/** Everything gatherSnapshot needs from the outside world. */
export interface GatherDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  agents: { id: string; label: string; command: string; installHint: string | null }[];
  pinned: Record<string, string>;
  newestInstall: (command: string) => Promise<{ path: string; version: string; others: { path: string; version: string }[] } | null>;
  runVersion: (command: string, args: string[]) => Promise<string | null>;
  findPython: () => string[] | null;
  bundledClaudeVersion: () => string | null;
  readText: (path: string) => string | null;
  listDirs: (dir: string) => string[];
  worktreesDir: string | null;
  liveWorktreeIds: Set<string>;
  quickjsLoads: () => Promise<boolean>;
  homedir: string;
}

/** The x.y.z in `git --version`'s output, or null when there is none. */
function parseGitVersion(output: string | null): string | null {
  if (output === null) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** The `auth_mode` string from Codex's auth.json; every other field stays unread. */
function parseAuthMode(authJson: string | null): string | null {
  if (authJson === null) return null;
  try {
    const parsed = JSON.parse(authJson) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const mode = (parsed as { auth_mode?: unknown }).auth_mode;
    return typeof mode === "string" ? mode : null;
  } catch {
    return null;
  }
}

/** Profile names from a Codex config.toml's `[profiles.<name>]` tables, in file order. */
export function parseCodexProfiles(toml: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    // A quoted name may contain dots; a bare one may not, and any deeper
    // table (`[profiles.x.model_providers]`) still names profile `x`.
    const m = /^\[\s*profiles\.(?:"([^"]+)"|([^.\]\s]+))/.exec(line);
    const name = m?.[1] ?? m?.[2];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** One agent's installs, chosen path and pin, from the newest-install probe. */
async function gatherAgent(agent: GatherDeps["agents"][number], d: GatherDeps): Promise<AgentSnapshot> {
  const r = await d.newestInstall(agent.command);
  const installs: AgentInstall[] = r ? [{ path: r.path, version: r.version }, ...r.others] : [];
  const pinned = d.pinned[agent.id] ?? null;
  // A pin only counts while its path is still one of the installs found.
  const chosen = pinned !== null && installs.some((install) => install.path === pinned) ? pinned : r?.path ?? null;
  return { id: agent.id, label: agent.label, command: agent.command, installs, chosen, pinned, installHint: agent.installHint };
}

/** Probe the machine through `d` and return the snapshot runChecks reads. */
export async function gatherSnapshot(d: GatherDeps): Promise<DoctorSnapshot> {
  const agents = await Promise.all(d.agents.map((agent) => gatherAgent(agent, d)));
  const joinPath = d.platform === "win32" ? win32.join : join;
  const codexHome = d.env.CODEX_HOME || joinPath(d.homedir, ".codex");
  const authJson = d.readText(joinPath(codexHome, "auth.json"));
  const worktreesDir = d.worktreesDir;
  const orphanDirs = worktreesDir
    ? d
        .listDirs(worktreesDir)
        .filter((name) => !d.liveWorktreeIds.has(name))
        .map((name) => join(worktreesDir, name))
    : [];
  return {
    platform: d.platform,
    agents,
    git: { version: parseGitVersion(await d.runVersion("git", ["--version"])) },
    python: d.findPython()?.join(" ") ?? null,
    claude: { bundledVersion: d.bundledClaudeVersion(), configDir: d.env.CLAUDE_CONFIG_DIR ?? null },
    codex: {
      home: codexHome,
      hasAuth: authJson !== null,
      authMode: parseAuthMode(authJson),
      profiles: parseCodexProfiles(d.readText(joinPath(codexHome, "config.toml")) ?? ""),
    },
    worktrees: { orphanDirs },
    quickjs: await d.quickjsLoads(),
  };
}
