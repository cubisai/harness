import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { argsFor } from "../src/main/agents/acp/driver";
import { exportTurnUsage } from "../src/main/agents/acp/opencode-usage";
import { majorOf } from "../src/main/agents/binaries";
import { ACP_PRESETS } from "../src/main/agents/registry";
import { ensureOpenCodeGuard, ensureOpenCodeGuardV2, OPENCODE_GUARD_SOURCE, OPENCODE_GUARD_V2_SOURCE, withOpenCodeGuard } from "../src/main/inject/opencode-guard";
import { toOpenCodeV2Config, toV2Permissions, withOpenCodeV2 } from "../src/main/inject/opencode-v2";
import { tempDir } from "./helpers";

describe("OpenCode v1/v2 launch args", () => {
  const opencode = ACP_PRESETS.find((p) => p.id === "opencode")!;
  it("keeps v1's uppercase log level and gives v2 (and later) lowercase", () => {
    expect(argsFor(opencode, null)).toEqual(["acp", "--print-logs", "--log-level", "INFO"]);
    expect(argsFor(opencode, 1)).toEqual(["acp", "--print-logs", "--log-level", "INFO"]);
    expect(argsFor(opencode, 2)).toEqual(["acp", "--print-logs", "--log-level", "info"]);
    expect(argsFor(opencode, 3)).toEqual(["acp", "--print-logs", "--log-level", "info"]);
  });
  it("uses plain args for agents without argsByMajor", () => {
    expect(argsFor({ args: ["acp"] }, 9)).toEqual(["acp"]);
  });
  it("reads the major from a version string", () => {
    expect(majorOf("2.1.0")).toBe(2);
    expect(majorOf("1.19.0")).toBe(1);
    expect(majorOf(null)).toBeNull();
    expect(majorOf("dev")).toBeNull();
  });
});

describe("exportTurnUsage per major", () => {
  it("runs `export <id>` on v1 and `session export <id> --standalone` on v2", async () => {
    const calls: string[][] = [];
    const run = async (_c: string, args: string[]) => {
      calls.push(args);
      return null;
    };
    await exportTurnUsage({ command: "opencode", sessionId: "ses_1", sinceMs: 0, run });
    await exportTurnUsage({ command: "opencode", sessionId: "ses_1", sinceMs: 0, run, major: 2 });
    expect(calls).toEqual([["export", "ses_1"], ["session", "export", "ses_1", "--standalone"]]);
  });
});

describe("toOpenCodeV2Config", () => {
  it("renames agents, prompt, variant, permissions, providers and plugins", () => {
    const v2 = toOpenCodeV2Config({
      $schema: "https://opencode.ai/config.json",
      model: "opencode/x",
      agent: {
        build: { model: "p/m", variant: "high", permission: { task: { "cubiq-dana": "allow", "*": "deny" } } },
        "cubiq-dana": { mode: "subagent", description: "Dana", prompt: "You are Dana.", steps: 4 },
      },
      permission: { bash: "ask", external_directory: { "/x/**": "allow" }, write: { "*.md": "allow" } },
      provider: { th: { npm: "@ai-sdk/openai-compatible", name: "TH", options: { baseURL: "https://h/v1", apiKey: "{env:K}" }, models: { a: { id: "wire-a", name: "A", limit: { context: 1, output: 2 } } } } },
      plugin: ["file:///p/guard", ["pkg", { on: true }]],
    });
    expect(v2).toEqual({
      $schema: "https://opencode.ai/config.json",
      model: "opencode/x",
      agents: {
        build: { model: "p/m#high", permissions: [{ action: "subagent", resource: "*", effect: "deny" }, { action: "subagent", resource: "cubiq-dana", effect: "allow" }] },
        "cubiq-dana": { mode: "subagent", description: "Dana", system: "You are Dana.", steps: 4 },
      },
      permissions: [
        { action: "external_directory", resource: "*", effect: "ask" },
        { action: "shell", resource: "*", effect: "ask" },
        { action: "external_directory", resource: "/x/**", effect: "allow" },
        { action: "edit", resource: "*.md", effect: "allow" },
      ],
      providers: { th: { package: "aisdk:@ai-sdk/openai-compatible", name: "TH", settings: { baseURL: "https://h/v1", apiKey: "{env:K}" }, models: { a: { modelID: "wire-a", name: "A", limit: { context: 1, output: 2 } } } } },
      plugins: [{ package: "file:///p/guard" }, { package: "pkg", options: { on: true } }],
    });
  });
  it("keeps external_directory and ignores non-string rules", () => {
    expect(toV2Permissions({ external_directory: "ask", edit: { "*": 3 } })).toEqual([{ action: "external_directory", resource: "*", effect: "ask" }]);
  });
  it("asks before reading outside the project like v1, unless a later rule says otherwise", () => {
    const ask = { action: "external_directory", resource: "*", effect: "ask" };
    expect(toOpenCodeV2Config({}).permissions).toEqual([ask]);
    expect(toOpenCodeV2Config({ permission: { external_directory: "allow" } }).permissions).toEqual([ask, { action: "external_directory", resource: "*", effect: "allow" }]);
    // An expert's read dirs (withOpenCodeReadDirs) still go through without a card.
    expect(toOpenCodeV2Config({ permission: { external_directory: { "/e/**": "allow" } } }).permissions).toEqual([ask, { action: "external_directory", resource: "/e/**", effect: "allow" }]);
  });
  it("leaves a plan without inline config, or with an error, alone", () => {
    const plan = { env: { A: "1" }, byok: false };
    expect(withOpenCodeV2(plan)).toEqual({ env: { A: "1" }, byok: false });
    const bad = { env: { OPENCODE_CONFIG_CONTENT: "{" }, byok: false };
    expect(withOpenCodeV2(bad).env.OPENCODE_CONFIG_CONTENT).toBe("{");
  });
  it("turns the guard's v1 plugin entry into a v2 package entry", () => {
    const plan = withOpenCodeV2(withOpenCodeGuard({ env: {}, byok: false }, { pluginUrl: "file:///d/cubiq-guard-v2" }));
    expect(JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      $schema: "https://opencode.ai/config.json",
      permissions: [{ action: "external_directory", resource: "*", effect: "ask" }],
      plugins: [{ package: "file:///d/cubiq-guard-v2" }],
    });
  });
});

describe("OpenCode v2 guard plugin", () => {
  it("is a package folder whose module reuses the v1 guard and ask unchanged", () => {
    const dir = tempDir();
    const url = ensureOpenCodeGuardV2(dir);
    const pkg = fileURLToPath(url);
    expect(pkg).toBe(join(dir, "cubiq-guard-v2"));
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"))).toMatchObject({ type: "module", main: "index.mjs" });
    expect(readFileSync(join(pkg, "index.mjs"), "utf8")).toBe(OPENCODE_GUARD_V2_SOURCE);
    const shared = OPENCODE_GUARD_SOURCE.slice(0, OPENCODE_GUARD_SOURCE.lastIndexOf("export default"));
    expect(OPENCODE_GUARD_V2_SOURCE.startsWith(shared)).toBe(true);
    // The v1 file is untouched by the v2 one.
    expect(readFileSync(fileURLToPath(ensureOpenCodeGuard(dir)), "utf8")).toBe(OPENCODE_GUARD_SOURCE);
  });

  it("maps v2's execute.before event onto the v1 ask: shell is bash, input is args", async () => {
    const dir = tempDir();
    const mod = (await import(`${ensureOpenCodeGuardV2(dir)}/index.mjs`)) as { default: { id: string; setup(ctx: unknown): Promise<void> } };
    expect(mod.default.id).toBe("cubiq.guard");
    let hook: ((event: unknown) => Promise<void>) | null = null;
    await mod.default.setup({ tool: { hook: async (name: string, fn: (event: unknown) => Promise<void>) => { if (name === "execute.before") hook = fn; } } });
    const bodies: unknown[] = [];
    const realFetch = globalThis.fetch;
    const prev = { url: process.env.CUBIQ_ASK_URL, token: process.env.CUBIQ_ASK_TOKEN };
    process.env.CUBIQ_ASK_URL = "http://cubiq.test/ask";
    process.env.CUBIQ_ASK_TOKEN = "t";
    globalThis.fetch = (async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const decision = bodies.length === 1 ? "allow-once" : "deny";
      return { ok: true, json: async () => ({ decision, reason: "no" }) };
    }) as never;
    try {
      await hook!({ tool: "shell", input: { command: "ls" }, id: "c1", sessionID: "s1" });
      await expect(hook!({ tool: "edit", input: { path: "a.txt", oldString: "a", newString: "b" }, id: "c2", sessionID: "s1" })).rejects.toThrow("no");
      await hook!({ tool: "read", input: { path: "a.txt" }, id: "c3", sessionID: "s1" });
    } finally {
      globalThis.fetch = realFetch;
      process.env.CUBIQ_ASK_URL = prev.url;
      process.env.CUBIQ_ASK_TOKEN = prev.token;
    }
    expect(bodies).toEqual([
      { tool: "bash", kind: "execute", summary: "ls", callID: "c1", sessionID: "s1" },
      { tool: "edit", kind: "edit", summary: "a.txt", callID: "c2", sessionID: "s1" },
    ]);
  });
});
