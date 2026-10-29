import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GatherDeps } from "../src/main/doctor/gather";
import { gatherSnapshot, parseCodexProfiles } from "../src/main/doctor/gather";

/** A gather that finds nothing; tests override just the parts they care about. */
function deps(over: Partial<GatherDeps> = {}): GatherDeps {
  return {
    platform: "darwin",
    env: {},
    agents: [],
    pinned: {},
    newestInstall: async () => null,
    runVersion: async () => null,
    findPython: () => null,
    bundledClaudeVersion: () => null,
    readText: () => null,
    listDirs: () => [],
    worktreesDir: null,
    liveWorktreeIds: new Set(),
    quickjsLoads: async () => true,
    homedir: "/Users/me",
    ...over,
  };
}

describe("gatherSnapshot", () => {
  it("uses a pinned install when it is one of the installs found", async () => {
    const newest = "/usr/local/bin/codex";
    const pinned = "/Users/me/.nvm/versions/node/v22.1.0/bin/codex";
    const s = await gatherSnapshot(
      deps({
        agents: [{ id: "codex", label: "Codex", command: "codex", installHint: "npm install -g @openai/codex" }],
        pinned: { codex: pinned },
        newestInstall: async () => ({
          path: newest,
          version: "0.50.0",
          others: [{ path: pinned, version: "0.49.0" }],
        }),
      }),
    );
    expect(s.agents[0]).toMatchObject({
      installs: [
        { path: newest, version: "0.50.0" },
        { path: pinned, version: "0.49.0" },
      ],
      chosen: pinned,
      pinned,
      installHint: "npm install -g @openai/codex",
    });
  });

  it("falls back to the newest install when the pinned path is gone", async () => {
    const newest = "/usr/local/bin/codex";
    const s = await gatherSnapshot(
      deps({
        agents: [{ id: "codex", label: "Codex", command: "codex", installHint: null }],
        pinned: { codex: "/Users/me/.nvm/versions/node/v22.1.0/bin/codex" },
        newestInstall: async () => ({ path: newest, version: "0.50.0", others: [] }),
      }),
    );
    expect(s.agents[0]?.chosen).toBe(newest);
    expect(s.agents[0]?.pinned).toBe("/Users/me/.nvm/versions/node/v22.1.0/bin/codex");
  });

  it("keeps the input agent order even when probes finish out of order", async () => {
    const agents = ["codex", "claude", "opencode"].map((id) => ({
      id,
      label: id,
      command: id,
      installHint: null,
    }));
    const delays: Record<string, number> = { codex: 20, claude: 10, opencode: 0 };
    const s = await gatherSnapshot(
      deps({
        agents,
        newestInstall: async (command) => {
          await new Promise((resolve) => setTimeout(resolve, delays[command] ?? 0));
          return { path: `/bin/${command}`, version: "1.2.3", others: [] };
        },
      }),
    );
    expect(s.agents.map((agent) => agent.id)).toEqual(["codex", "claude", "opencode"]);
    expect(s.agents.map((agent) => agent.installs[0]?.path)).toEqual(["/bin/codex", "/bin/claude", "/bin/opencode"]);
  });

  it("parses the git version out of --version's output", async () => {
    const s = await gatherSnapshot(deps({ runVersion: async (command) => (command === "git" ? "git version 2.50.1 (Apple Git-155)" : null) }));
    expect(s.git.version).toBe("2.50.1");
  });

  it("reads Codex's auth mode without carrying any other auth field", async () => {
    const auth = '{"auth_mode":"chatgpt","tokens":{"x":"secret"}}';
    const s = await gatherSnapshot(deps({ readText: (path) => (path.endsWith("auth.json") ? auth : null) }));
    expect(s.codex.hasAuth).toBe(true);
    expect(s.codex.authMode).toBe("chatgpt");
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("reports worktree folders whose thread ids are no longer live", async () => {
    const worktreesDir = "/Users/me/Library/Application Support/CubiQ/worktrees";
    const s = await gatherSnapshot(
      deps({
        worktreesDir,
        listDirs: () => ["live-thread", "old-thread"],
        liveWorktreeIds: new Set(["live-thread"]),
      }),
    );
    // The platform's own join: backslashes on Windows.
    expect(s.worktrees.orphanDirs).toEqual([join(worktreesDir, "old-thread")]);
  });

  it("builds the Codex home with backslashes on win32", async () => {
    const seen: string[] = [];
    const s = await gatherSnapshot(
      deps({
        platform: "win32",
        homedir: "C:\\Users\\me",
        readText: (path) => {
          seen.push(path);
          return null;
        },
      }),
    );
    expect(s.codex.home).toBe("C:\\Users\\me\\.codex");
    expect(seen).toContain("C:\\Users\\me\\.codex\\auth.json");
    expect(seen).toContain("C:\\Users\\me\\.codex\\config.toml");
  });
});

describe("parseCodexProfiles", () => {
  it("reads profile tables in file order, skipping deeper tables and comments", () => {
    const toml = [
      "# [profiles.commented]",
      "[profiles.work]",
      'model = "gpt-5"',
      "",
      '[profiles."team.fast"]',
      'model = "o3"',
      "",
      "[profiles.deep.model_providers]",
      'name = "local"',
      "",
      "[profiles.work]",
    ].join("\n");
    expect(parseCodexProfiles(toml)).toEqual(["work", "team.fast", "deep"]);
  });

  it("returns nothing for a config without profiles", () => {
    expect(parseCodexProfiles('model = "gpt-5"\n')).toEqual([]);
  });
});
