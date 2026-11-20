import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcpDriver } from "../src/main/agents/acp/driver";
import { createCodexDriver } from "../src/main/agents/codex";
import { startToolServer } from "../src/main/mcp-http";
import type { TurnInput } from "../src/main/agents/types";
import type { ThreadEvent } from "../src/shared/types";
import { closeAfter, tempDir } from "./helpers";

afterEach(() => vi.unstubAllEnvs());

describe("legacy direct stdio ACP session migration", () => {
  it.each(["acp", "codex"] as const)("%s cannot retry into an old connector configuration after native close/unload failed", async (engine) => {
    const result = join(tempDir(), "result.json"), home = tempDir();
    vi.stubEnv("CODEX_HOME", home);
    const options = { clientVersion: "fixture", injection: () => ({ byok: false, env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home, MANAGED_RESULT: result, MANAGED_FAIL_CLOSE: "1" } }) };
    const driver = engine === "acp" ? createAcpDriver({ id: "fixture", label: "Fixture", command: process.execPath, args: [resolve("test/fixtures/managed-approval-agent.mjs"), engine] }, options)
      : createCodexDriver({ command: process.execPath, args: [resolve("test/fixtures/managed-approval-agent.mjs"), engine], ...options });
    closeAfter(() => driver.dispose?.());
    const events: ThreadEvent[] = [];
    const input: TurnInput = { threadId: "thread", projectId: "project", cwd: tempDir(), prompt: "idle", sessionId: null, model: "default", permissionMode: "ask", signal: new AbortController().signal, tools: [], mcpServers: [{ name: "shop", enabled: true, spec: { type: "stdio", command: "never-start-this-command" } }], onEvent: (e) => events.push(e), onTextDelta: () => {}, onSession: (id) => { input.sessionId = id; }, requestPermission: async () => "deny", requestPlanDecision: async () => ({ keep: "" }) };
    await driver.runTurn(input); expect(JSON.parse(readFileSync(result, "utf8")).prompts).toBe(1);
    input.managedPermission = () => false;
    input.mcpServers = [{ name: "shop", enabled: true, mainMediated: true, spec: { type: "http", url: `http://127.0.0.1:12345/mcp-up/managed/${"a".repeat(48)}` } }];
    for (let i = 0; i < 2; i++) { try { await driver.runTurn(input); } catch { /* A driver may reject admission rather than emit an error event. */ } }
    expect(JSON.parse(readFileSync(result, "utf8")).prompts).toBe(1);
  });
  it("a successful native reopen replaces direct stdio with mediation, and HTTP-incapable ACP drops it visibly", async () => {
    for (const http of [true, false]) {
      const result = join(tempDir(), "result.json"), home = tempDir(), events: ThreadEvent[] = [];
      const driver = createAcpDriver({ id: "fixture", label: "Fixture", command: process.execPath, args: [resolve("test/fixtures/managed-approval-agent.mjs"), "acp"] }, { clientVersion: "fixture", injection: () => ({ byok: false, env: { PATH: process.env.PATH ?? "", HOME: home, MANAGED_RESULT: result, ...(!http ? { MANAGED_NO_HTTP: "1" } : {}) } }) }); closeAfter(() => driver.dispose?.());
      const input: TurnInput = { threadId: "thread", projectId: "project", cwd: tempDir(), prompt: "idle", sessionId: null, model: "default", permissionMode: "ask", signal: new AbortController().signal, tools: [], mcpServers: [{ name: "shop", enabled: true, spec: { type: "stdio", command: "never-start-this-command" } }], onEvent: (e) => events.push(e), onTextDelta: () => {}, onSession: (id) => { input.sessionId = id; }, requestPermission: async () => "deny", requestPlanDecision: async () => ({ keep: "" }) };
      await driver.runTurn(input);
      input.managedPermission = () => false;
      input.mcpServers = [{ name: "shop", enabled: true, mainMediated: true, spec: { type: "http", url: `http://127.0.0.1:12345/mcp-up/managed/${"a".repeat(48)}` } }];
      await driver.runTurn(input);
      const report = JSON.parse(readFileSync(result, "utf8")); expect(report.prompts).toBe(2);
      expect(JSON.stringify(report.servers)).not.toContain("never-start-this-command");
      if (http) expect(report.servers[0]?.type).toBe("http");
      else { expect(report.servers).toEqual([]); expect(events.some((e) => e.kind === "notice" && e.text.includes("HTTP"))).toBe(true); }
    }
  });
  it("refuses an unreopenable old session on every retry; only an explicit fresh session adopts mediation", async () => {
    const result = join(tempDir(), "result.json"), home = tempDir(), server = await startToolServer(() => []); closeAfter(() => { void server.close(); });
    const driver = createAcpDriver({ id: "fixture", label: "Fixture", command: process.execPath, args: [resolve("test/fixtures/managed-approval-agent.mjs"), "acp"] }, { clientVersion: "fixture", injection: () => ({ byok: false, env: { PATH: process.env.PATH ?? "", HOME: home, MANAGED_RESULT: result, MANAGED_NO_RESUME: "1" } }), toolServer: async () => server }); closeAfter(() => driver.dispose?.());
    const events: ThreadEvent[] = [];
    const input: TurnInput = { threadId: "thread", projectId: "project", cwd: tempDir(), prompt: "idle", sessionId: null, model: "default", permissionMode: "ask", signal: new AbortController().signal, tools: [], mcpServers: [{ name: "shop", enabled: true, spec: { type: "stdio", command: "never-start-this-command" } }], onEvent: (e) => events.push(e), onTextDelta: () => {}, onSession: (id) => { input.sessionId = id; }, requestPermission: async () => "deny", requestPlanDecision: async () => ({ keep: "" }) };
    await driver.runTurn(input); expect(JSON.parse(readFileSync(result, "utf8")).prompts).toBe(1);
    input.managedPermission = () => false;
    input.mcpServers = [{ name: "shop", enabled: true, mainMediated: true, spec: { type: "http", url: `http://127.0.0.1:12345/mcp-up/managed/${"a".repeat(48)}` } }];
    await driver.runTurn(input); await driver.runTurn(input);
    expect(events.filter((e) => e.kind === "error").map((e) => e.message).join("\n")).toContain("direct stdio");
    expect(JSON.parse(readFileSync(result, "utf8")).prompts).toBe(1);
    input.sessionId = null; await driver.runTurn(input); expect(JSON.parse(readFileSync(result, "utf8")).prompts).toBe(2);
  });
});
