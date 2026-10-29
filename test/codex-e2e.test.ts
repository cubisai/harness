import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ThreadEvent } from "../src/shared/types";
import { createCodexDriver } from "../src/main/agents/codex";
import type { LimitsPatch } from "../src/main/agents/limits";
import { onPath } from "../src/main/agents/registry";
import type { HarnessTool, TurnInput } from "../src/main/agents/types";
import { startToolServer } from "../src/main/mcp-http";
import { startFakeOpenAI } from "./fixtures/fake-openai.mjs";
import { closeAfter } from "./helpers";
import { Store } from "../src/main/db";
import { injectWithLedger } from "../src/main/handoff";

// The real `codex app-server` against a fake Responses API model, so the
// whole path runs without an account: thread config, MCP tool listing,
// approval, the tool call, and its result going back to the model. Runs
// when codex is on PATH, or at UNSKILLED_CODEX_BIN.
const codex = process.env.UNSKILLED_CODEX_BIN ?? (onPath("codex") ? "codex" : null);

describe.skipIf(!codex)("Codex end to end (real app-server, fake model)", () => {
  it("offers the browser tools from the first turn and runs one with approval", async () => {
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
        requestPlanDecision: async () => ({ keep: "" }),
        ...over,
      });
      return { events, asked, session };
    };

    const first = await run({ tools: [evalTool] });
    expect(model.offered.at(-1)).toEqual(["browser_eval"]);
    expect(model.namespaces[0]).toContain("mcp__docs: whoami");
    // Limits come from the model's response headers, with no extra request.
    expect(limitReports.flatMap((p) => p.windows ?? [])).toContainEqual({ id: "codex:primary", label: "5-hour", usedPercent: 42, resetsAt: 1_790_000_000_000 });
    expect(limitReports.flatMap((p) => p.windows ?? [])).toContainEqual({ id: "codex:secondary", label: "Weekly", usedPercent: 9, resetsAt: null });
    // The tools are there from the first turn, so that's when the approval and the eval happen.
    expect(first.asked).toEqual(["browser_eval: expression: 1+1"]);
    expect(ran).toEqual(["1+1"]);

    const second = await run({ sessionId: first.session, tools: [evalTool] });
    expect(second.session).toBe(first.session);
    expect(model.offered.at(-1)).toEqual(["browser_eval"]);
    // The same tools on the same thread change nothing, so there's no reopen notice;
    // the model already has the result and just answers.
    expect(second.events.filter((e) => e.kind !== "turn-start" && e.kind !== "turn-end")).toEqual([
      { kind: "assistant-text", text: "Evaluated.", itemId: expect.any(String) },
    ]);
  }, 60_000);

  it("seeds a thread with thread/inject_items once, and the next turn sends the injected history", async () => {
    const model = await startFakeOpenAI();
    closeAfter(() => void model.server.close());
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
    });
    closeAfter(() => driver.dispose?.());
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    closeAfter(() => (previousHome === undefined ? delete process.env.CODEX_HOME : (process.env.CODEX_HOME = previousHome)));
    const store = new Store(join(mkdtempSync(join(tmpdir(), "unskilled-ledger-")), "t.db"));
    closeAfter(() => store.close());

    const cwd = mkdtempSync(join(tmpdir(), "unskilled-codex-cwd-"));
    const items = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "HANDOFF-MARKER from claude" }] },
      { type: "function_call", call_id: "call_handoff_1", name: "shell", arguments: JSON.stringify({ command: ["npm", "test"] }) },
      { type: "function_call_output", call_id: "call_handoff_1", output: "3 passed" },
    ];
    let sessionId: string | null = null;
    const seed = () =>
      driver.seed!({
        threadId: "t",
        sessionId,
        cwd,
        model: "default",
        permissionMode: "ask",
        tools: [],
        mcpServers: [],
        items,
        onSession: () => {},
        inject: (sid, send) => injectWithLedger(store, { threadId: "t", provider: "codex", sessionId: sid, checkpointId: "cp" }, items, "codex/inject_items", send),
      });

    const first = await seed();
    expect(first).toMatchObject({ mode: "seeded", sent: 3 });
    sessionId = first.sessionId!;
    expect(model.requests).toHaveLength(0); // injecting never runs the model
    expect((await seed()).sent).toBe(0);

    const events: ThreadEvent[] = [];
    await driver.runTurn({
      threadId: "t",
      cwd,
      prompt: "continue",
      sessionId,
      model: "default",
      permissionMode: "ask",
      signal: new AbortController().signal,
      tools: [],
      mcpServers: [],
      onEvent: (e) => events.push(e),
      onTextDelta: () => {},
      onSession: () => {},
      requestPermission: async () => "deny",
      requestPlanDecision: async () => ({ keep: "" }),
    });
    const sent = JSON.stringify(model.requests.at(-1)!.input);
    expect(sent).toContain("HANDOFF-MARKER from claude");
    expect(sent.split("call_handoff_1").length - 1).toBe(2); // the call and its output, once each
  }, 60_000);
});
