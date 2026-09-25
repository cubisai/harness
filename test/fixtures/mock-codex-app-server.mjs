// A tiny stand-in for `codex app-server` for tests. The prompt picks the scenario:
//   "tool" - asks approval for a command, then reports it
//   "slow" - streams until turn/interrupt
//   "browser" - calls browser_eval on the thread's "unskilled" MCP server,
//              asking first when its config says to, as Codex does
//   other  - replies "Hi, <prompt>" in two deltas
// Like Codex, a thread keeps the config it was loaded with until it is
// unsubscribed (unloaded); resuming a loaded thread doesn't change it.
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ method, params });
let nextId = 5000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const threads = new Set(["known-thread"]);
let interrupted = false;
let extraRoots = [];
const configs = new Map(); // loaded thread id -> its config

async function callTool(server, name, args) {
  const client = new Client({ name: "mock-codex", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.http_headers } }));
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return send({ id, result: { userAgent: "mock" } });
    case "initialized":
      return;
    case "skills/extraRoots/set":
      extraRoots = params.extraRoots;
      return send({ id, result: {} });
    case "model/list":
      return send({ id, result: { data: [{ id: "gpt-mock", displayName: "GPT Mock", hidden: false }, { id: "hidden", displayName: "H", hidden: true }], nextCursor: null } });
    case "thread/start": {
      const tid = `thread-${threads.size}`;
      threads.add(tid);
      configs.set(tid, params.config ?? null);
      return send({ id, result: { thread: { id: tid } } });
    }
    case "thread/resume":
      if (!threads.has(params.threadId)) return send({ id, error: { code: -32600, message: "no such thread" } });
      if (!configs.has(params.threadId)) configs.set(params.threadId, params.config ?? null);
      return send({ id, result: { thread: { id: params.threadId } } });
    case "thread/unsubscribe":
      configs.delete(params.threadId);
      return send({ id, result: { status: "unsubscribed" } });
    case "turn/interrupt":
      interrupted = true;
      return send({ id, result: {} });
    case "turn/start": {
      const threadId = params.threadId;
      const text = params.input.map((i) => i.text).join("");
      const turn = { id: "turn-1", status: "inProgress", error: null, durationMs: null, items: [] };
      send({ id, result: { turn } });
      notify("turn/started", { threadId, turn });
      interrupted = false;
      const done = (status) => notify("turn/completed", { threadId, turn: { ...turn, status, durationMs: 42 } });
      if (text === "roots") {
        notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id: "m", text: JSON.stringify(extraRoots) } });
        return done("completed");
      }
      if (text === "slow") {
        while (!interrupted) {
          notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "m1", delta: "." });
          await new Promise((r) => setTimeout(r, 20));
        }
        return done("interrupted");
      }
      if (text === "browser") {
        const server = configs.get(threadId)?.mcp_servers?.unskilled;
        if (!server) {
          notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id: "m", text: "no tools" } });
          return done("completed");
        }
        const args = { expression: "1+1" };
        const item = { type: "mcpToolCall", id: "t1", server: "unskilled", tool: "browser_eval", status: "inProgress", arguments: args, result: null, error: null };
        notify("item/started", { threadId, turnId: turn.id, item });
        let allowed = true;
        if (server.tools?.browser_eval?.approval_mode === "prompt") {
          const res = await ask("mcpServer/elicitation/request", {
            threadId,
            turnId: turn.id,
            serverName: "unskilled",
            mode: "form",
            _meta: { codex_approval_kind: "mcp_tool_call", tool_params_display: [{ name: "expression", value: "1+1", display_name: "expression" }] },
            message: 'Allow the unskilled MCP server to run tool "browser_eval"?',
            requestedSchema: { type: "object", properties: {} },
          });
          allowed = res.action === "accept";
        }
        const result = allowed ? await callTool(server, "browser_eval", args) : null;
        notify("item/completed", {
          threadId,
          turnId: turn.id,
          item: { ...item, status: allowed ? "completed" : "failed", result, error: allowed ? null : { message: "user rejected MCP tool call" } },
        });
        return done("completed");
      }
      if (text === "tool") {
        const item = { type: "commandExecution", id: "c1", command: "npm test", status: "inProgress", aggregatedOutput: null, exitCode: null };
        notify("item/started", { threadId, turnId: turn.id, item });
        const res = await ask("item/commandExecution/requestApproval", { threadId, turnId: turn.id, itemId: "c1", command: "npm test", startedAtMs: 0 });
        const ok = res.decision === "accept" || res.decision === "acceptForSession";
        notify("item/completed", { threadId, turnId: turn.id, item: { ...item, status: ok ? "completed" : "declined", aggregatedOutput: ok ? `3 passed (${res.decision})` : null, exitCode: ok ? 0 : null } });
      }
      notify("item/completed", { threadId, turnId: turn.id, item: { type: "reasoning", id: "r1", summary: ["Considering it."], content: [] } });
      notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "m2", delta: "Hi, " });
      notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "m2", delta: text });
      notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id: "m2", text: `Hi, ${text}` } });
      notify("thread/tokenUsage/updated", { threadId, turnId: turn.id, tokenUsage: { last: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 12, totalTokens: 912, reasoningOutputTokens: 0, cacheWriteInputTokens: 0 }, total: {}, modelContextWindow: null } });
      // Codex sends these as responses arrive: sparse, account-wide, no threadId.
      notify("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1790000000 }, secondary: null, planType: "plus" } });
      return done("completed");
    }
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } });
  }
});
