// The pure decision core behind /doctor. It reads a snapshot of what is on the
// machine and returns findings; it never probes, spawns or touches the disk.

import type { DoctorFinding, DoctorFix } from "../../shared/doctor";

/** One installed copy of an agent CLI, and the version it reported. */
export interface AgentInstall {
  path: string;
  version: string | null;
  /** Where the path's symlinks lead (an npm shim in /usr/local/bin is really under lib/node_modules). */
  realPath?: string;
}

/** An install's source, read from where it really lives. */
const sourceOf = (install: AgentInstall): InstallSource => installSource(install.realPath ?? install.path);

/** Everything the doctor knows about one agent CLI. */
export interface AgentSnapshot {
  id: string;
  label: string;
  command: string;
  /** Installs in the order they were found. */
  installs: AgentInstall[];
  /** The path CubiQ uses, or null when it found none. */
  chosen: string | null;
  /** The path the user pinned, or null. */
  pinned: string | null;
  /** Shown as a copyable command when the agent isn't installed. */
  installHint: string | null;
}

/** Everything the doctor knows about the machine, gathered before runChecks. */
export interface DoctorSnapshot {
  platform: NodeJS.Platform;
  agents: AgentSnapshot[];
  git: { version: string | null };
  python: string | null;
  claude: { bundledVersion: string | null; configDir: string | null };
  codex: { home: string; hasAuth: boolean; authMode: string | null; profiles: string[] };
  worktrees: { orphanDirs: string[] };
  quickjs: boolean;
}

/** Oldest version of each agent CubiQ supports. */
export const MIN_VERSIONS: Record<string, string> = {
  claude: "2.0.0",
  codex: "0.40.0",
  opencode: "1.0.0",
};

/** Agents CubiQ always reports on, even when nothing was found. */
const CORE_AGENTS = new Set(Object.keys(MIN_VERSIONS));

/** The npm package that owns each agent's CLI. */
const NPM_PACKAGES: Record<string, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  opencode: "opencode-ai",
};

/** Where an install came from, inferred from its path. */
export type InstallSource = "npm" | "bun" | "homebrew" | "native" | "volta" | "pnpm" | "other";

/** Classify an install by its location, ignoring case and slash direction. */
export function installSource(path: string): InstallSource {
  const p = path.toLowerCase().replace(/\\/g, "/");
  if (p.includes("/.bun/")) return "bun";
  if (p.includes("/homebrew/") || p.includes("/cellar/") || (p.startsWith("/usr/local/bin") && p.includes("cellar"))) {
    return "homebrew";
  }
  if (p.includes("/.volta/")) return "volta";
  if (p.includes("/pnpm/") || p.includes("/.pnpm")) return "pnpm";
  if (p.includes("/fnm/") || p.includes("/fnm_multishells/") || p.includes("/.fnm/") || p.includes("/nvm/") || p.includes("/.nvm/")) {
    return "npm";
  }
  if (p.includes("/node_modules/") || p.includes("/npm/") || p.includes("/.npm-global/") || p.includes("/lib/node_modules")) {
    return "npm";
  }
  if (p.includes("/.local/bin/claude") || p.includes("/.local/share/claude/") || p.includes("/.opencode/bin/") || p.includes("/.codex/bin/") || p.includes("/.cursor/")) {
    return "native";
  }
  return "other";
}

/** The npm install/upgrade shape, with npm's Windows shim. */
function npmInstall(pkg: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  return { command: platform === "win32" ? "npm.cmd" : "npm", args: ["install", "-g", pkg] };
}

/** Per-agent upgrade recipes; there is no universal upgrade command. */
const UPGRADES: Record<string, (source: InstallSource, platform: NodeJS.Platform) => { command: string; args: string[] } | null> = {
  claude: (source, platform) => {
    if (source === "native") return { command: "claude", args: ["update"] };
    if (source === "npm") return npmInstall("@anthropic-ai/claude-code@latest", platform);
    return null;
  },
  codex: (source, platform) => {
    if (source === "npm") return npmInstall("@openai/codex@latest", platform);
    if (source === "homebrew") return { command: "brew", args: ["upgrade", "codex"] };
    return null;
  },
  opencode: (source, platform) => {
    if (source === "native" || source === "other") return { command: "opencode", args: ["upgrade"] };
    if (source === "npm") return npmInstall("opencode-ai@latest", platform);
    if (source === "homebrew") return { command: "brew", args: ["upgrade", "opencode"] };
    if (source === "bun") return { command: "bun", args: ["add", "-g", "opencode-ai@latest"] };
    return null;
  },
};

/** The safe upgrade command for one agent and install source, or null when there is none. */
export function upgradeCommand(
  agent: string,
  source: InstallSource,
  platform: NodeJS.Platform,
): { command: string; args: string[] } | null {
  return UPGRADES[agent]?.(source, platform) ?? null;
}

/** Major.minor.patch as numbers, or null when the string isn't one. */
function versionParts(version: string | null): [number, number, number] | null {
  if (version === null) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Numeric part-by-part comparison: negative, zero, or positive. */
function compareParts(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when `version` is numerically below `min`. */
function olderThan(version: string, min: string): boolean {
  const v = versionParts(version);
  const m = versionParts(min);
  return v !== null && m !== null && compareParts(v, m) < 0;
}

/** The install at the path CubiQ uses, when the snapshot still lists it. */
function chosenInstall(agent: AgentSnapshot): AgentInstall | null {
  if (agent.chosen === null) return null;
  return agent.installs.find((install) => install.path === agent.chosen) ?? null;
}

/** The baseline "not installed" finding, with the install hint when there is one. */
function missingFinding(agent: AgentSnapshot): DoctorFinding {
  const fixes: DoctorFix[] = agent.installHint
    ? [{ kind: "copy", label: "Copy install command", text: agent.installHint }]
    : [];
  return {
    id: `${agent.id}:missing`,
    group: "agents",
    agent: agent.id,
    level: "warn",
    title: `${agent.label} isn't installed`,
    detail: agent.installHint ? "Install it, then run /doctor again." : "CubiQ couldn't find it on this machine.",
    fixes,
  };
}

/** The healthy single-install finding. */
function installedFinding(agent: AgentSnapshot, install: AgentInstall): DoctorFinding {
  const pinned = agent.pinned === install.path ? " It's pinned in CubiQ." : "";
  return {
    id: `${agent.id}:installed`,
    group: "agents",
    agent: agent.id,
    level: "ok",
    title: install.version ? `${agent.label} ${install.version} at ${install.path}` : `${agent.label} at ${install.path}`,
    detail: `Installed via ${sourceOf(install)}.${pinned}`,
    fixes: [],
  };
}

/** OpenCode-specific findings: a v1/v2 mix, and a healthy v2. */
function opencodeFindings(agent: AgentSnapshot | undefined): DoctorFinding[] {
  if (!agent) return [];
  const hasMajorOne = agent.installs.some((install) => {
    const parts = versionParts(install.version);
    return parts !== null && parts[0] === 1;
  });
  const hasMajorTwo = agent.installs.some((install) => {
    const parts = versionParts(install.version);
    return parts !== null && parts[0]! >= 2;
  });
  const out: DoctorFinding[] = [];
  if (hasMajorOne && hasMajorTwo) {
    out.push({
      id: "opencode:v1-v2",
      group: "agents",
      agent: agent.id,
      level: "warn",
      title: "OpenCode v1 and v2 are both installed",
      detail:
        "They share the `opencode` command, so whichever comes first on PATH wins. Remove the package-manager v1 install.",
      fixes: [],
    });
  }
  const chosen = chosenInstall(agent);
  const chosenParts = versionParts(chosen?.version ?? null);
  if (chosen !== null && chosenParts !== null && chosenParts[0]! >= 2) {
    out.push({
      id: "opencode:major",
      group: "agents",
      agent: agent.id,
      level: "ok",
      title: "OpenCode v2 detected",
      detail: `CubiQ uses ${chosen.path} (${chosen.version}).`,
      fixes: [],
    });
  }
  return out;
}

/** Claude-specific finding: say how the bundled copy differs from the one in use. */
function claudeFindings(agent: AgentSnapshot | undefined, s: DoctorSnapshot): DoctorFinding[] {
  if (!agent) return [];
  const chosen = chosenInstall(agent);
  const bundled = s.claude.bundledVersion;
  const chosenParts = versionParts(chosen?.version ?? null);
  const bundledParts = versionParts(bundled);
  if (chosen === null || bundled === null || chosenParts === null || bundledParts === null) return [];
  if (compareParts(chosenParts, bundledParts) === 0) return [];
  const chosenIsNewer = compareParts(chosenParts, bundledParts) > 0;
  return [
    {
      id: "claude:bundled",
      group: "agents",
      agent: agent.id,
      level: "ok",
      title: `CubiQ uses Claude Code ${chosen.version}`,
      detail: `The bundled copy is ${bundled}; CubiQ uses ${chosenIsNewer ? "the newer install" : "the install"} at ${chosen.path}.`,
      fixes: [],
    },
  ];
}

/** Codex-specific findings: sign-in and profiles. */
function codexFindings(agent: AgentSnapshot | undefined, s: DoctorSnapshot): DoctorFinding[] {
  const agentId = agent?.id ?? "codex";
  const out: DoctorFinding[] = [];
  if (!s.codex.hasAuth) {
    out.push({
      id: "codex:auth",
      group: "agents",
      agent: agentId,
      level: "warn",
      title: "Codex isn't signed in",
      detail: "Run `codex login`, then run /doctor again.",
      fixes: [{ kind: "copy", label: "Copy login command", text: "codex login" }],
    });
  }
  if (s.codex.profiles.length > 0) {
    const home = s.codex.home.replace(/[\\/]+$/, "");
    out.push({
      id: "codex:profiles",
      group: "agents",
      agent: agentId,
      level: "ok",
      title: `Codex profiles: ${s.codex.profiles.join(", ")}`,
      detail: `Found in ${home}/config.toml. CubiQ uses the default profile.`,
      fixes: [],
    });
  }
  return out;
}

/** The per-agent checks whose order matches the report's d/e/f sections. */
const SPECIAL_CHECKS: readonly {
  id: string;
  findings: (agent: AgentSnapshot | undefined, s: DoctorSnapshot) => DoctorFinding[];
}[] = [
  { id: "opencode", findings: opencodeFindings },
  { id: "claude", findings: claudeFindings },
  { id: "codex", findings: codexFindings },
];

/** Turn a snapshot into the report's findings, in a stable order. */
export function runChecks(s: DoctorSnapshot): DoctorFinding[] {
  const out: DoctorFinding[] = [];

  // a) One baseline finding per agent: missing, healthy, or (below) duplicated.
  for (const agent of s.agents) {
    if (agent.installs.length === 0) {
      if (agent.installHint !== null || CORE_AGENTS.has(agent.id)) out.push(missingFinding(agent));
    } else if (agent.installs.length === 1) {
      out.push(installedFinding(agent, agent.installs[0]!));
    }
  }

  // b) Duplicates, with pin fixes for the copies CubiQ isn't using.
  for (const agent of s.agents) {
    if (agent.installs.length < 2) continue;
    const chosen = chosenInstall(agent);
    const lines = agent.installs.map(
      (install) => `${install.path} (${install.version ?? "unknown"}, ${sourceOf(install)})`,
    );
    lines.push(chosen ? `CubiQ uses ${chosen.path}.` : "CubiQ doesn't use any of them.");
    // A pin can always be undone, without pinning some other copy instead.
    const fixes: DoctorFix[] = agent.pinned !== null ? [{ kind: "pin", label: "Use the newest automatically", agent: agent.id, path: null }] : [];
    for (const install of agent.installs) {
      if (install.path === agent.chosen) continue;
      fixes.push({
        kind: "pin",
        label: `Use ${install.version ?? "this install"} at ${install.path}`,
        agent: agent.id,
        path: install.path,
      });
      const pkg = NPM_PACKAGES[agent.id];
      if (pkg && sourceOf(install) === "npm") {
        fixes.push({ kind: "copy", label: "Copy uninstall command", text: `npm uninstall -g ${pkg}` });
      }
    }
    out.push({
      id: `${agent.id}:duplicates`,
      group: "agents",
      agent: agent.id,
      level: "warn",
      title: `${agent.label} is installed ${agent.installs.length} times`,
      detail: lines.join("\n"),
      fixes,
    });
  }

  // c) The install CubiQ uses must be readable and new enough.
  for (const agent of s.agents) {
    const min = MIN_VERSIONS[agent.id];
    if (!min) continue;
    const install = chosenInstall(agent);
    if (!install) continue;
    if (versionParts(install.version) === null) {
      out.push({
        id: `${agent.id}:version`,
        group: "agents",
        agent: agent.id,
        level: "warn",
        title: `Couldn't read ${agent.label}'s version`,
        detail: `CubiQ uses ${install.path}, but it didn't report a version.`,
        fixes: [],
      });
      continue;
    }
    if (!olderThan(install.version!, min)) continue;
    const upgrade = upgradeCommand(agent.id, sourceOf(install), s.platform);
    const fixes: DoctorFix[] = upgrade
      ? [{ kind: "run", label: `Upgrade ${agent.label}`, command: upgrade.command, args: upgrade.args }]
      : [];
    out.push({
      id: `${agent.id}:outdated`,
      group: "agents",
      agent: agent.id,
      level: "error",
      title: `${agent.label} ${install.version} is older than CubiQ supports (${min}+)`,
      detail: `CubiQ uses ${install.path}. Upgrade to ${min} or newer.`,
      fixes,
    });
  }

  // d/e/f) The rules that only three agents have.
  for (const check of SPECIAL_CHECKS) {
    const agent = s.agents.find((candidate) => candidate.id === check.id);
    out.push(...check.findings(agent, s));
  }

  // g) Environment.
  if (s.git.version === null) {
    out.push({
      id: "environment:git",
      group: "environment",
      level: "error",
      title: "git isn't on PATH",
      detail: "CubiQ needs git for worktrees, diffs and the git guard.",
      fixes: [],
    });
  }
  if (s.python === null) {
    out.push({
      id: "environment:python",
      group: "environment",
      level: "warn",
      title: "Python not found: the git guard is off",
      detail: "Install Python 3 to turn the git guard back on.",
      fixes: [],
    });
  }
  if (!s.quickjs) {
    out.push({
      id: "environment:quickjs",
      group: "environment",
      level: "warn",
      title: "Code mode's sandbox (QuickJS) can't load",
      detail: "Reinstall CubiQ or check that its native module matches this platform.",
      fixes: [],
    });
  }

  // h) Worktrees.
  if (s.worktrees.orphanDirs.length > 0) {
    out.push({
      id: "worktrees:orphans",
      group: "worktrees",
      level: "warn",
      title: `${s.worktrees.orphanDirs.length} leftover worktree folders`,
      detail: "These folders no longer belong to a project.",
      fixes: [{ kind: "prune-worktrees", label: "Remove them", dirs: s.worktrees.orphanDirs }],
    });
  }

  return out;
}
