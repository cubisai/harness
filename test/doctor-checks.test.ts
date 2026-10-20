import { describe, expect, it } from "vitest";
import type { AgentSnapshot, DoctorSnapshot, InstallSource } from "../src/main/doctor/checks";
import { installSource, MIN_VERSIONS, runChecks, upgradeCommand } from "../src/main/doctor/checks";

/** An agent with neutral defaults, so each test only states what it cares about. */
function agent(over: Partial<AgentSnapshot> & { id: string; label: string }): AgentSnapshot {
  return {
    command: over.id,
    installs: [],
    chosen: null,
    pinned: null,
    installHint: null,
    ...over,
  };
}

/** A healthy machine; tests override just the part under test. */
function snapshot(over: Partial<DoctorSnapshot> = {}): DoctorSnapshot {
  return {
    platform: "darwin",
    agents: [],
    git: { version: "2.50.1" },
    python: "/usr/bin/python3",
    claude: { bundledVersion: null, configDir: null },
    codex: { home: "/Users/me/.codex", hasAuth: true, authMode: null, profiles: [] },
    worktrees: { orphanDirs: [] },
    quickjs: true,
    ...over,
  };
}

describe("installSource", () => {
  it("classifies macOS and Linux installs", () => {
    const cases: [string, InstallSource][] = [
      ["/opt/homebrew/bin/opencode", "homebrew"],
      ["/usr/local/Cellar/codex/0.50.0/bin/codex", "homebrew"],
      ["/Users/me/.opencode/bin/opencode", "native"],
      ["/Users/me/.local/bin/claude", "native"],
      ["/Users/me/.codex/bin/codex", "native"],
      ["/Users/me/.cursor/bin/cursor-agent", "native"],
      ["/Users/me/.bun/bin/opencode", "bun"],
      ["/Users/me/.volta/bin/claude", "volta"],
      ["/Users/me/.pnpm/global/bin/opencode", "pnpm"],
      ["/Users/me/.local/state/fnm_multishells/123_456/bin/opencode", "npm"],
      ["/Users/me/.nvm/versions/node/v22.1.0/bin/codex", "npm"],
      ["/Users/me/.npm-global/bin/claude", "npm"],
      ["/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "npm"],
      ["/usr/local/bin/claude", "other"],
      ["/somewhere/else/codex", "other"],
    ];
    for (const [path, source] of cases) expect(installSource(path)).toBe(source);
  });

  it("classifies Windows-style paths and ignores case", () => {
    expect(installSource("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd")).toBe("npm");
    expect(installSource("C:\\Users\\me\\.BUN\\bin\\opencode.exe")).toBe("bun");
    expect(installSource("C:\\Users\\me\\.opencode\\bin\\opencode.exe")).toBe("native");
  });
});

describe("upgradeCommand", () => {
  it("uses each agent's own native upgrade", () => {
    expect(upgradeCommand("claude", "native", "darwin")).toEqual({ command: "claude", args: ["update"] });
    expect(upgradeCommand("opencode", "native", "linux")).toEqual({ command: "opencode", args: ["upgrade"] });
    expect(upgradeCommand("opencode", "other", "linux")).toEqual({ command: "opencode", args: ["upgrade"] });
  });

  it("uses npm, brew and bun where that is how the CLI was installed", () => {
    expect(upgradeCommand("claude", "npm", "darwin")).toEqual({
      command: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code@latest"],
    });
    expect(upgradeCommand("codex", "npm", "linux")).toEqual({
      command: "npm",
      args: ["install", "-g", "@openai/codex@latest"],
    });
    expect(upgradeCommand("codex", "homebrew", "darwin")).toEqual({ command: "brew", args: ["upgrade", "codex"] });
    expect(upgradeCommand("opencode", "homebrew", "darwin")).toEqual({ command: "brew", args: ["upgrade", "opencode"] });
    expect(upgradeCommand("opencode", "bun", "darwin")).toEqual({
      command: "bun",
      args: ["add", "-g", "opencode-ai@latest"],
    });
  });

  it("uses npm.cmd on Windows", () => {
    expect(upgradeCommand("claude", "npm", "win32")).toEqual({
      command: "npm.cmd",
      args: ["install", "-g", "@anthropic-ai/claude-code@latest"],
    });
  });

  it("returns null when the source has no safe upgrade", () => {
    expect(upgradeCommand("claude", "homebrew", "darwin")).toBeNull();
    expect(upgradeCommand("codex", "native", "darwin")).toBeNull();
    expect(upgradeCommand("opencode", "pnpm", "darwin")).toBeNull();
    expect(upgradeCommand("cursor", "npm", "darwin")).toBeNull();
  });
});

describe("runChecks", () => {
  it("skips an agent it knows nothing about", () => {
    const s = snapshot({ agents: [agent({ id: "cursor", label: "Cursor" })] });
    expect(runChecks(s)).toEqual([]);
  });

  it("reports missing agents, with a copyable install hint when there is one", () => {
    const s = snapshot({
      agents: [
        agent({ id: "opencode", label: "OpenCode", installHint: "npm install -g opencode-ai" }),
        agent({ id: "claude", label: "Claude Code" }),
        agent({ id: "cursor", label: "Cursor" }),
      ],
    });
    const out = runChecks(s);
    expect(out.map((finding) => finding.id)).toEqual(["opencode:missing", "claude:missing"]);
    expect(out[0]).toMatchObject({
      group: "agents",
      agent: "opencode",
      level: "warn",
      title: "OpenCode isn't installed",
      fixes: [{ kind: "copy", label: "Copy install command", text: "npm install -g opencode-ai" }],
    });
    expect(out[1]).toMatchObject({ level: "warn", title: "Claude Code isn't installed", fixes: [] });
  });

  it("reports one healthy install", () => {
    const path = "/Users/me/.local/bin/claude";
    const s = snapshot({
      agents: [
        agent({
          id: "claude",
          label: "Claude Code",
          installs: [{ path, version: "2.1.0" }],
          chosen: path,
        }),
      ],
    });
    const finding = runChecks(s).find((f) => f.id === "claude:installed");
    expect(finding).toMatchObject({
      group: "agents",
      agent: "claude",
      level: "ok",
      title: `Claude Code 2.1.0 at ${path}`,
      fixes: [],
    });
    expect(finding?.detail).toContain("native");
  });

  it("reports duplicates with pin fixes and an uninstall hint, never a run fix", () => {
    const npmPath = "/Users/me/.npm-global/bin/claude";
    const nativePath = "/Users/me/.local/bin/claude";
    const s = snapshot({
      agents: [
        agent({
          id: "claude",
          label: "Claude Code",
          installs: [
            { path: npmPath, version: "1.9.0" },
            { path: nativePath, version: "2.1.0" },
          ],
          chosen: nativePath,
        }),
      ],
    });
    const finding = runChecks(s).find((f) => f.id === "claude:duplicates");
    expect(finding).toMatchObject({
      level: "warn",
      title: "Claude Code is installed 2 times",
      detail: `${npmPath} (1.9.0, npm)\n${nativePath} (2.1.0, native)\nCubiQ uses ${nativePath}.`,
    });
    expect(finding?.fixes).toEqual([
      { kind: "pin", label: `Use 1.9.0 at ${npmPath}`, agent: "claude", path: npmPath },
      { kind: "copy", label: "Copy uninstall command", text: "npm uninstall -g @anthropic-ai/claude-code" },
    ]);
    expect(finding?.fixes.map((fix) => fix.kind)).not.toContain("run");
  });

  it("offers to drop a pin first, so CubiQ can go back to the newest install", () => {
    const npmPath = "/Users/me/.npm-global/bin/claude";
    const nativePath = "/Users/me/.local/bin/claude";
    const s = snapshot({
      agents: [
        agent({
          id: "claude",
          label: "Claude Code",
          installs: [
            { path: npmPath, version: "1.9.0" },
            { path: nativePath, version: "2.1.0" },
          ],
          chosen: npmPath,
          pinned: npmPath,
        }),
      ],
    });
    const finding = runChecks(s).find((f) => f.id === "claude:duplicates");
    expect(finding?.fixes[0]).toEqual({ kind: "pin", label: "Use the newest automatically", agent: "claude", path: null });
    expect(finding?.fixes[1]).toEqual({ kind: "pin", label: `Use 2.1.0 at ${nativePath}`, agent: "claude", path: nativePath });
  });

  it("flags a chosen install below the minimum version", () => {
    const path = "/Users/me/.local/bin/claude";
    const s = snapshot({
      agents: [
        agent({
          id: "claude",
          label: "Claude Code",
          installs: [{ path, version: "1.9.0" }],
          chosen: path,
        }),
      ],
    });
    const finding = runChecks(s).find((f) => f.id === "claude:outdated");
    expect(finding).toMatchObject({
      level: "error",
      title: "Claude Code 1.9.0 is older than CubiQ supports (2.0.0+)",
      fixes: [{ kind: "run", label: "Upgrade Claude Code", command: "claude", args: ["update"] }],
    });
    expect(finding?.detail).toContain(path);
  });

  it("warns when the chosen install's version can't be read", () => {
    const path = "/Users/me/.local/bin/claude";
    const s = snapshot({
      agents: [
        agent({
          id: "claude",
          label: "Claude Code",
          installs: [{ path, version: null }],
          chosen: path,
        }),
      ],
    });
    const finding = runChecks(s).find((f) => f.id === "claude:version");
    expect(finding).toMatchObject({
      level: "warn",
      title: "Couldn't read Claude Code's version",
      fixes: [],
    });
    expect(finding?.detail).toContain(path);
  });

  it("compares version parts numerically, so 1.9.0 is below 1.10.0", () => {
    const original = MIN_VERSIONS.opencode!;
    const path = "/Users/me/.opencode/bin/opencode";
    try {
      MIN_VERSIONS.opencode = "1.10.0";
      const s = snapshot({
        agents: [
          agent({
            id: "opencode",
            label: "OpenCode",
            installs: [{ path, version: "1.9.0" }],
            chosen: path,
          }),
        ],
      });
      expect(runChecks(s).some((f) => f.id === "opencode:outdated")).toBe(true);
    } finally {
      MIN_VERSIONS.opencode = original;
    }
  });

  it("accepts the minimum version itself", () => {
    const path = "/usr/local/bin/codex";
    const s = snapshot({
      agents: [
        agent({
          id: "codex",
          label: "Codex",
          installs: [{ path, version: "0.40.0" }],
          chosen: path,
        }),
      ],
    });
    expect(runChecks(s).some((f) => f.id === "codex:outdated")).toBe(false);
  });

  it("warns about a mix of OpenCode v1 and v2 and reports a chosen v2", () => {
    const v1 = "/Users/me/.npm-global/bin/opencode";
    const v2 = "/Users/me/.opencode/bin/opencode";
    const s = snapshot({
      agents: [
        agent({
          id: "opencode",
          label: "OpenCode",
          installs: [
            { path: v1, version: "1.18.0" },
            { path: v2, version: "2.0.1" },
          ],
          chosen: v2,
        }),
      ],
    });
    const out = runChecks(s);
    const mix = out.find((f) => f.id === "opencode:v1-v2");
    expect(mix).toMatchObject({ level: "warn", title: "OpenCode v1 and v2 are both installed", fixes: [] });
    expect(mix?.detail).toContain("whichever comes first on PATH wins");
    expect(out.find((f) => f.id === "opencode:major")).toMatchObject({
      level: "ok",
      title: "OpenCode v2 detected",
    });
  });

  it("reports the newer Claude Code when the bundled and chosen versions differ", () => {
    const path = "/Users/me/.local/bin/claude";
    const s = snapshot({
      claude: { bundledVersion: "2.0.0", configDir: "/Users/me/Library/Application Support/CubiQ/claude" },
      agents: [
        agent({
          id: "claude",
          label: "Claude Code",
          installs: [{ path, version: "2.1.0" }],
          chosen: path,
        }),
      ],
    });
    const finding = runChecks(s).find((f) => f.id === "claude:bundled");
    expect(finding).toMatchObject({ level: "ok", title: "CubiQ uses Claude Code 2.1.0", fixes: [] });
    expect(finding?.detail).toContain("bundled copy is 2.0.0");
    expect(finding?.detail).toContain("newer install");
    expect(finding?.detail).toContain(path);
  });

  it("stays quiet about Claude Code when the versions match", () => {
    const path = "/Users/me/.local/bin/claude";
    const s = snapshot({
      claude: { bundledVersion: "2.1.0", configDir: null },
      agents: [
        agent({
          id: "claude",
          label: "Claude Code",
          installs: [{ path, version: "2.1.0" }],
          chosen: path,
        }),
      ],
    });
    expect(runChecks(s).some((f) => f.id === "claude:bundled")).toBe(false);
  });

  it("reports Codex sign-in and profiles", () => {
    const path = "/usr/local/bin/codex";
    const s = snapshot({
      codex: { home: "/Users/me/.codex", hasAuth: false, authMode: null, profiles: ["work", "fast"] },
      agents: [
        agent({
          id: "codex",
          label: "Codex",
          installs: [{ path, version: "0.50.0" }],
          chosen: path,
        }),
      ],
    });
    const out = runChecks(s);
    expect(out.find((f) => f.id === "codex:auth")).toMatchObject({
      level: "warn",
      title: "Codex isn't signed in",
      fixes: [{ kind: "copy", label: "Copy login command", text: "codex login" }],
    });
    const profiles = out.find((f) => f.id === "codex:profiles");
    expect(profiles).toMatchObject({ level: "ok", title: "Codex profiles: work, fast", fixes: [] });
    expect(profiles?.detail).toBe("Found in /Users/me/.codex/config.toml. CubiQ uses the default profile.");
  });

  it("omits the profiles finding when there are none", () => {
    const path = "/usr/local/bin/codex";
    const s = snapshot({
      agents: [
        agent({
          id: "codex",
          label: "Codex",
          installs: [{ path, version: "0.50.0" }],
          chosen: path,
        }),
      ],
    });
    expect(runChecks(s).some((f) => f.id === "codex:profiles")).toBe(false);
  });

  it("reports environment gaps", () => {
    const out = runChecks(snapshot({ git: { version: null }, python: null, quickjs: false }));
    expect(out.map((f) => f.id)).toEqual(["environment:git", "environment:python", "environment:quickjs"]);
    expect(out.map((f) => f.level)).toEqual(["error", "warn", "warn"]);
    expect(out[0]?.title).toBe("git isn't on PATH");
    expect(out[1]?.title).toBe("Python not found: the git guard is off");
    expect(out[2]?.title).toBe("Code mode's sandbox (QuickJS) can't load");
  });

  it("reports leftover worktree folders with a prune fix", () => {
    const dirs = ["/tmp/cubiq-wt-a", "/tmp/cubiq-wt-b"];
    const out = runChecks(snapshot({ worktrees: { orphanDirs: dirs } }));
    expect(out).toEqual([
      {
        id: "worktrees:orphans",
        group: "worktrees",
        level: "warn",
        title: "2 leftover worktree folders",
        detail: "These folders no longer belong to a project.",
        fixes: [{ kind: "prune-worktrees", label: "Remove them", dirs }],
      },
    ]);
  });

  it("gives every finding a stable, unique id and a fixes array", () => {
    const out = runChecks(
      snapshot({
        git: { version: null },
        quickjs: false,
        codex: { home: "/Users/me/.codex", hasAuth: false, authMode: null, profiles: ["work"] },
        worktrees: { orphanDirs: ["/tmp/cubiq-wt-a"] },
        agents: [
          agent({
            id: "claude",
            label: "Claude Code",
            installs: [
              { path: "/Users/me/.npm-global/bin/claude", version: "1.9.0" },
              { path: "/Users/me/.local/bin/claude", version: "2.1.0" },
            ],
            chosen: "/Users/me/.local/bin/claude",
          }),
          agent({
            id: "codex",
            label: "Codex",
            installs: [{ path: "/usr/local/bin/codex", version: "0.50.0" }],
            chosen: "/usr/local/bin/codex",
          }),
          agent({
            id: "opencode",
            label: "OpenCode",
            installs: [
              { path: "/Users/me/.npm-global/bin/opencode", version: "1.18.0" },
              { path: "/Users/me/.opencode/bin/opencode", version: "2.0.1" },
            ],
            chosen: "/Users/me/.opencode/bin/opencode",
          }),
        ],
      }),
    );
    expect(new Set(out.map((f) => f.id)).size).toBe(out.length);
    for (const finding of out) expect(Array.isArray(finding.fixes)).toBe(true);
  });
});

describe("install source from the resolved path", () => {
  it("reads Claude's native versions folder as native", () => {
    expect(installSource("/Users/me/.local/share/claude/versions/2.1.304")).toBe("native");
  });
  it("classifies a symlinked npm shim by where it leads", () => {
    const findings = runChecks({
      platform: "darwin",
      agents: [
        {
          id: "opencode",
          label: "OpenCode",
          command: "opencode",
          installs: [
            { path: "/Users/me/.local/bin/opencode", version: "1.19.0", realPath: "/Users/me/.local/share/fnm/node-versions/v22/installation/lib/node_modules/opencode-ai/bin/opencode" },
            { path: "/usr/local/bin/opencode", version: "1.0.126", realPath: "/usr/local/lib/node_modules/opencode-ai/bin/opencode" },
          ],
          chosen: "/Users/me/.local/bin/opencode",
          pinned: null,
          installHint: null,
        },
      ],
      git: { version: "2.50.1" },
      python: "python3",
      claude: { bundledVersion: null, configDir: null },
      codex: { home: "/Users/me/.codex", hasAuth: true, authMode: "chatgpt", profiles: [] },
      worktrees: { orphanDirs: [] },
      quickjs: true,
    });
    const dup = findings.find((f) => f.id === "opencode:duplicates")!;
    expect(dup.detail).toContain("/usr/local/bin/opencode (1.0.126, npm)");
    expect(dup.fixes.some((f) => f.kind === "copy" && f.text === "npm uninstall -g opencode-ai")).toBe(true);
  });
});
