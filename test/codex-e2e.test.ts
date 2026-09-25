import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { closeAfter } from "./helpers";

// The real `codex app-server` against a fake Responses API model, so the
// whole path runs without an account: thread config, MCP tool listing,
// approval, the tool call, and its result going back to the model. Runs
// when codex is on PATH, or at UNSKILLED_CODEX_BIN.
const codex = process.env.UNSKILLED_CODEX_BIN ?? (onPath("codex") ? "codex" : null);

/** A model that calls mcp__unskilled.browser_eval whenever it's offered and not yet called this turn. */
async function fakeModel(): Promise<{ server: Server; url: string; offered: string[][]; namespaces: string[][] }> {
  const offered: string[][] = [];
  const namespaces: string[][] = [];
  let n = 0;
  const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!req.url?.endsWith("/responses")) return void res.writeHead(404).end();
      const request = JSON.parse(body) as { tools?: { name?: string; tools?: { name: string }[] }[]; input: unknown };
      const ns = request.tools?.find((t) => t.name === "mcp__unskilled");
      offered.push(ns?.tools?.map((t) => t.name) ?? []);
      namespaces.push((request.tools ?? []).filter((t) => t.tools).map((t) => `${t.name}: ${t.tools!.map((x) => x.name).join(",")}`));
      const id = `r${++n}`;
      const called = JSON.stringify(request.input).includes("function_call_output");
      const item =
        ns && !called
          ? { type: "function_call", call_id: `c${n}`, namespace: "mcp__unskilled", name: "browser_eval", arguments: '{"expression":"1+1"}' }
          : { type: "message", role: "assistant", id: `m${n}`, content: [{ type: "output_text", text: called ? "Evaluated." : "Hello." }] };
      const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 };
      res.writeHead(200, {
        "content-type": "text/event-stream",
        // What the real backend sends for plan limits; Codex turns them into account/rateLimits/updated.
        "x-codex-primary-used-percent": "42",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1790000000",
        "x-codex-secondary-used-percent": "9",
        "x-codex-secondary-window-minutes": "10080",
      });
      res.end(
        sse([
          { type: "response.created", response: { id } },
          { type: "response.output_item.done", item },
          { type: "response.completed", response: { id, usage } },
        ]),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, offered, namespaces };
}

describe.skipIf(!codex)("Codex end to end (real app-server, fake model)", () => {
  it("adds the browser tools mid-thread and runs one with approval", async () => {
    const model = await fakeModel();
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
    expect(second.events.filter((e) => e.kind !== "turn-end")).toEqual([
      { kind: "tool-use", toolUseId: expect.any(String), name: "browser_eval", summary: '{"expression":"1+1"}' },
      { kind: "tool-result", toolUseId: expect.any(String), isError: false, summary: "2" },
      { kind: "assistant-text", text: "Evaluated." },
    ]);
  }, 60_000);
});
