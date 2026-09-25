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

// The real `codex app-server` against a fake Responses API model, so the
// whole path runs without an account: thread config, MCP tool listing,
// approval, the tool call, and its result going back to the model. Runs
// when codex is on PATH, or at UNSKILLED_CODEX_BIN.
const codex = process.env.UNSKILLED_CODEX_BIN ?? (onPath("codex") ? "codex" : null);

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
});
