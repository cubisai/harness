import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionMode, ThreadEvent } from "../src/shared/types";
import { CODEX_CAPABILITIES, SAFE_DEFAULTS, skillDeliveryGap, withCapabilities } from "../src/main/agents/capabilities";
import { createAcpDriver } from "../src/main/agents/acp/driver";
import { createClaudeDriver } from "../src/main/agents/claude";
import { createCodexDriver } from "../src/main/agents/codex";
import { loadAcpAgents } from "../src/main/agents/registry";
import type { TurnInput } from "../src/main/agents/types";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import { catalog, closeAfter, tempDir } from "./helpers";

const MOCK = join(__dirname, "fixtures", "mock-acp-agent.mjs");

const EXACT_DEFAULTS = {
  mcpStdio: false,
  mcpHttp: false,
  preToolGuard: false,
  resume: false,
  fork: false,
  revert: false,
  compaction: false,
  perMessageModel: false,
  vision: false,
  webSearch: false,
  planMode: false,
  interrupt: false,
  liveReasoning: false,
  skillsDelivery: { mode: "none" },
  permissionGranularity: "modeOnly",
  guardEnforcement: { ask: "warnOnly", "auto-edit": "warnOnly", full: "warnOnly" },
  sandbox: "none",
};

function turn(prompt: string): { input: TurnInput; events: ThreadEvent[] } {
  const events: ThreadEvent[] = [];
  return {
    events,
    input: {
      threadId: "t1",
      cwd: tempDir(),
      prompt,
      sessionId: null,
      model: "default",
      permissionMode: "ask" as PermissionMode,
      signal: new AbortController().signal,
      tools: [],
      mcpServers: [],
      onEvent: (e) => events.push(e),
      onTextDelta: () => {},
      onSession: () => {},
      requestPermission: async (): Promise<PermissionDecision> => "allow-once",
    },
  };
}

describe("SAFE_DEFAULTS", () => {
  it("is exactly the declared-safe shape", () => {
    expect(SAFE_DEFAULTS).toEqual(EXACT_DEFAULTS);
  });

  it("is frozen, top-level and nested", () => {
    expect(Object.isFrozen(SAFE_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(SAFE_DEFAULTS.skillsDelivery)).toBe(true);
    expect(Object.isFrozen(SAFE_DEFAULTS.guardEnforcement)).toBe(true);
    expect(() => {
      (SAFE_DEFAULTS as { mcpStdio: boolean }).mcpStdio = true;
    }).toThrow();
  });

  it("withCapabilities returns a fresh, independent copy", () => {
    const patched = withCapabilities(SAFE_DEFAULTS, { mcpHttp: true, skillsDelivery: { mode: "projectWrite", prefix: "" } });
    expect(patched).toMatchObject({ mcpHttp: true, skillsDelivery: { mode: "projectWrite", prefix: "" } });
    expect(patched).not.toBe(SAFE_DEFAULTS);
    expect(patched.skillsDelivery).not.toBe(SAFE_DEFAULTS.skillsDelivery);
    expect(SAFE_DEFAULTS.mcpHttp).toBe(false);
  });
});

describe("agents.json capabilities", () => {
  function entryFile(entry: Record<string, unknown>): string {
    const file = join(tempDir(), "agents.json");
    writeFileSync(file, JSON.stringify({ agents: [entry] }));
    return file;
  }

  it("gives an unknown entry SAFE_DEFAULTS", () => {
    const file = entryFile({ id: "mystery", label: "Mystery", command: process.execPath, args: [] });
    const { agents, custom } = loadAcpAgents(file, (cmd) => cmd === process.execPath);
    const entry = agents.find((a) => a.id === "mystery")!;
    const d = createAcpDriver(entry, { clientVersion: "t" });
    closeAfter(() => d.dispose?.());
    expect(d.capabilities).toEqual(SAFE_DEFAULTS);
    expect(d.skillsDelivery).toEqual({ mode: "none" });
    // The claimed field is never carried into the parsed entry.
    expect(custom[0]!.capabilities).toBeUndefined();
  });

  it("still yields SAFE_DEFAULTS when the entry claims a capability", () => {
    const file = entryFile({ id: "mystery2", label: "Mystery", command: process.execPath, args: [], capabilities: { mcpHttp: true } });
    const { agents } = loadAcpAgents(file, (cmd) => cmd === process.execPath);
    const d = createAcpDriver(agents.find((a) => a.id === "mystery2")!, { clientVersion: "t" });
    closeAfter(() => d.dispose?.());
    expect(d.capabilities).toEqual(SAFE_DEFAULTS);
  });

  it("upgrades only skillsDirEnv, to envDir", () => {
    const file = entryFile({ id: "mystery3", label: "Mystery", command: process.execPath, args: [], skillsDirEnv: "MY_SKILLS" });
    const { agents } = loadAcpAgents(file, (cmd) => cmd === process.execPath);
    const d = createAcpDriver(agents.find((a) => a.id === "mystery3")!, { clientVersion: "t" });
    closeAfter(() => d.dispose?.());
    expect(d.capabilities).toEqual(withCapabilities(SAFE_DEFAULTS, { skillsDelivery: { mode: "envDir", prefix: "" } }));
  });
});

describe("Service.listAgents capabilities", () => {
  it("exposes a complete capabilities object for every driver", () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const claude = createClaudeDriver({});
    const codex = createCodexDriver({ command: "codex", args: ["app-server"], clientVersion: "t" });
    const acp = createAcpDriver({ id: "acp-test", label: "ACP Test", command: process.execPath, args: [MOCK] }, { clientVersion: "t" });
    closeAfter(() => {
      claude.dispose?.();
      codex.dispose?.();
      acp.dispose?.();
    });
    const service = new Service(store, catalog(), [claude, codex, acp], () => {});
    const infos = service.listAgents();
    expect(infos.map((a) => a.id)).toEqual(["claude", "codex", "acp-test"]);
    for (const info of infos) {
      expect(info.capabilities).toBeDefined();
      expect(Object.keys(info.capabilities).sort()).toEqual(Object.keys(SAFE_DEFAULTS).sort());
    }
  });
});

describe("Codex capabilities", () => {
  it("blocks under ask/auto-edit and warns under full", () => {
    expect(CODEX_CAPABILITIES.guardEnforcement).toEqual({ ask: "block", "auto-edit": "block", full: "warnOnly" });
  });
});

describe("skillDeliveryGap", () => {
  it("names the gap for projectWrite and none, and is null otherwise", () => {
    expect(skillDeliveryGap({ mode: "projectWrite" })).toBeTruthy();
    expect(skillDeliveryGap({ mode: "none" })).toBeTruthy();
    expect(skillDeliveryGap({ mode: "plugin" })).toBeNull();
    expect(skillDeliveryGap({ mode: "extraRoots" })).toBeNull();
    expect(skillDeliveryGap({ mode: "envDir" })).toBeNull();
  });
});

describe("ACP initialize is authoritative", () => {
  it("turns off a preset's claimed capability and says so exactly once", async () => {
    const d = createAcpDriver(
      {
        id: "mock",
        label: "Mock",
        command: process.execPath,
        args: [MOCK],
        env: { MOCK_ACP_NO_HTTP: "1" },
        capabilities: { mcpHttp: true },
      },
      { clientVersion: "t" },
    );
    closeAfter(() => d.dispose?.());
    expect(d.capabilities.mcpHttp).toBe(true);
    const t = turn("world");
    await d.runTurn(t.input);
    expect(d.capabilities.mcpHttp).toBe(false);
    const notices = t.events.filter((e): e is { kind: "notice"; text: string } => e.kind === "notice" && /MCP over HTTP/.test(e.text));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("Mock");
  });
});
