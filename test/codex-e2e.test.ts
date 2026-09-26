import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Provider, ThreadEvent } from "../src/shared/types";
import { CODEX_DEFAULT_MODEL, createCodexDriver } from "../src/main/agents/codex";
import type { LimitsPatch } from "../src/main/agents/limits";
import { onPath } from "../src/main/agents/registry";
import type { HarnessTool, TurnInput } from "../src/main/agents/types";
import { type InjectionSource, injectionFor } from "../src/main/inject";
import { codexInstructions, prepareCodexPlan, validateCodexCatalog } from "../src/main/inject/codex";
import { startToolServer } from "../src/main/mcp-http";
import { startFakeOpenAI } from "./fixtures/fake-openai.mjs";
import { closeAfter } from "./helpers";

// The real `codex app-server` against a fake Responses API model, so the
// whole path runs without an account: thread config, MCP tool listing,
// approval, the tool call, and its result going back to the model. Runs
// when codex is on PATH, or at UNSKILLED_CODEX_BIN.
const codex = process.env.UNSKILLED_CODEX_BIN ?? (onPath("codex") ? "codex" : null);

const KEY = "test-codex-key";

function provider(baseURL: string): Provider {
  return {
    id: "fake",
    label: "Fake",
    wireProtocol: "openai-responses",
    baseURL,
    secret: { kind: "safeStorage", ciphertext: "x" },
    models: [{ id: "fake", modelID: "fake-model", capabilities: { tools: true, vision: false, reasoning: false }, contextWindow: 128_000, maxOutput: 16_000 }],
  };
}

/** A fake settings surface for one BYOK provider. */
function source(p: Provider): InjectionSource {
  return {
    credential: () => ({ kind: "byok", providerId: p.id }),
    providers: () => [p],
    providerSecret: () => KEY,
    secretEnvNames: () => [],
    get: () => ({ theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: false, editor: null, providerInjection: {} }),
  };
}

describe.skipIf(!codex)("Codex end to end (real app-server, fake model)", () => {
  it("adds the browser tools mid-thread and runs one with approval", async () => {
    const model = await startFakeOpenAI();
    closeAfter(() => void model.server.close());
    const ran: string[] = [];
    const limitReports: LimitsPatch[] = [];
    const evalTool: HarnessTool = {
      name: "browser_eval",
      description: "Evaluate JavaScript in the page",
      input: { expression: z.string() },
      autoAllow: false,
      run: async (a) => {
        ran.push((a as { expression: string }).expression);
        return { text: "2" };
      },
    };
    const tools = await startToolServer(() => [evalTool]);
    closeAfter(() => void tools.close());
    const home = mkdtempSync(join(tmpdir(), "unskilled-codex-home-"));
    const driver = createCodexDriver({
      command: codex!,
      args: [
        "app-server",
        "-c", 'model_provider="fake"',
        "-c", 'model="fake-model"',
        "-c", `model_providers.fake={ name="fake", base_url="${model.url}", wire_api="responses", requires_openai_auth=false }`,
      ],
      clientVersion: "test",
      toolServer: async () => tools,
      onLimits: (p) => limitReports.push(p),
    });
    closeAfter(() => driver.dispose?.());
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home; // the driver passes process.env to codex
    closeAfter(() => (previousHome === undefined ? delete process.env.CODEX_HOME : (process.env.CODEX_HOME = previousHome)));

    const cwd = mkdtempSync(join(tmpdir(), "unskilled-codex-cwd-"));
    const run = async (over: Partial<TurnInput>) => {
      const events: ThreadEvent[] = [];
      const asked: string[] = [];
      let session = "";
      await driver.runTurn({
        threadId: "t",
        cwd,
        prompt: "hi",
        sessionId: null,
        model: "default",
        permissionMode: "ask",
        signal: new AbortController().signal,
        tools: [],
        // A user MCP server (mcp.json), there from the first turn.
        mcpServers: [{ name: "docs", enabled: true, spec: { type: "stdio", command: process.execPath, args: [join(__dirname, "fixtures", "mock-mcp-stdio.mjs")] } }],
        onEvent: (e) => events.push(e),
        onTextDelta: () => {},
        onSession: (s) => (session = s),
        requestPermission: async (r) => {
          asked.push(`${r.toolName}: ${r.summary}`);
          return "allow-once";
        },
        ...over,
      });
      return { events, asked, session };
    };

    const first = await run({});
    expect(first.events.find((e) => e.kind === "assistant-text")).toMatchObject({ text: "Hello." });
    expect(model.offered.at(-1)).toEqual([]);
    expect(model.namespaces[0]).toContain("mcp__docs: whoami");
    // Limits come from the model's response headers, with no extra request.
    expect(limitReports.flatMap((p) => p.windows ?? [])).toContainEqual({ id: "codex:primary", label: "5-hour", usedPercent: 42, resetsAt: 1_790_000_000_000 });
    expect(limitReports.flatMap((p) => p.windows ?? [])).toContainEqual({ id: "codex:secondary", label: "Weekly", usedPercent: 9, resetsAt: null });

    const second = await run({ sessionId: first.session, tools: [evalTool] });
    expect(second.session).toBe(first.session);
    expect(model.offered.at(-1)).toEqual(["browser_eval"]);
    expect(second.asked).toEqual(["browser_eval: expression: 1+1"]);
    expect(ran).toEqual(["1+1"]);
    expect(second.events.filter((e) => e.kind !== "turn-start" && e.kind !== "turn-end")).toEqual([
      { kind: "tool-use", toolUseId: expect.any(String), name: "browser_eval", summary: '{"expression":"1+1"}' },
      { kind: "tool-result", toolUseId: expect.any(String), isError: false, summary: "2" },
      { kind: "assistant-text", text: "Evaluated." },
    ]);
  }, 60_000);

  it("runs a turn through an injected BYOK provider", async () => {
    const model = await startFakeOpenAI({ requireAuth: true });
    closeAfter(() => void model.server.close());

    const home = mkdtempSync(join(tmpdir(), "unskilled-codex-home-"));
    const configFile = join(home, "config.toml");
    writeFileSync(configFile, '# user config\n[tui]\ntheme = "dark"\n');
    const before = readFileSync(configFile);
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    closeAfter(() => (previousHome === undefined ? delete process.env.CODEX_HOME : (process.env.CODEX_HOME = previousHome)));

    const catalogDir = mkdtempSync(join(tmpdir(), "unskilled-codex-catalogs-"));
    const plan = prepareCodexPlan(
      injectionFor(source(provider(model.url)), "codex", process.env, {
        codexCatalogDir: catalogDir,
        codexInstructions: () => codexInstructions(codex!),
      }),
      codex!,
    );
    expect(plan.error).toBeUndefined();

    const driver = createCodexDriver({
      command: codex!,
      args: ["app-server"],
      clientVersion: "test",
      injection: () => plan,
    });
    closeAfter(() => driver.dispose?.());

    const cwd = mkdtempSync(join(tmpdir(), "unskilled-codex-cwd-"));
    const events: ThreadEvent[] = [];
    await driver.runTurn({
      threadId: "t",
      cwd,
      prompt: "hi",
      sessionId: null,
      model: CODEX_DEFAULT_MODEL,
      permissionMode: "full",
      signal: new AbortController().signal,
      tools: [],
      mcpServers: [],
      onEvent: (e) => events.push(e),
      onTextDelta: () => {},
      onSession: () => {},
      requestPermission: async () => "allow-once",
    });

    expect(events.find((e) => e.kind === "error")).toBeUndefined();
    expect(model.requests.length).toBeGreaterThanOrEqual(1);
    expect(model.authHeaders.length).toBeGreaterThanOrEqual(1);
    for (const auth of model.authHeaders) expect(auth).toBe(`Bearer ${KEY}`);
    expect(model.requests[0]!.model).toBe("fake-model");
    // The injected plan never touches $CODEX_HOME.
    expect(readFileSync(configFile).equals(before)).toBe(true);
    expect(readdirSync(home).filter((f) => f.endsWith(".config.toml") && f !== "config.toml")).toEqual([]);
  }, 90_000);

  it("validates a generated catalog and rejects a broken one", () => {
    const home = mkdtempSync(join(tmpdir(), "unskilled-codex-home-"));
    const env = { ...process.env, CODEX_HOME: home };
    const bad = join(mkdtempSync(join(tmpdir(), "unskilled-codex-bad-")), "bad.json");
    writeFileSync(bad, JSON.stringify({ models: [{ slug: "x" }] }));
    expect(validateCodexCatalog(codex!, bad, env)).toMatch(/rejected/);

    const catalogDir = mkdtempSync(join(tmpdir(), "unskilled-codex-good-"));
    const plan = injectionFor(source(provider("https://gw.example.com/v1")), "codex", env, {
      codexCatalogDir: catalogDir,
      codexInstructions: () => codexInstructions(codex!, env),
    });
    prepareCodexPlan(plan, codex!);
    expect(plan.error).toBeUndefined();
    expect(validateCodexCatalog(codex!, plan.files![0]!.path, env)).toBeNull();
  }, 30_000);
});
