// A tiny stand-in for `codex app-server` for tests. The prompt picks the scenario:
//   "tool" - asks approval for a command, then reports it
//   "tool:<command>" - asks approval for <command>, then reports it
//   "run:<command>" - runs <command> without asking (as Full mode does), then reports it
//   "file" - asks approval for a file change, then reports it
//   "slow" - streams until turn/interrupt
//   "browser" - calls browser_eval on the thread's "cubiq" MCP server,
//              asking first when its config says to, as Codex does
//   "roots" - reports the extra skills roots the app set
//   "unsubs" - reports how many thread/unsubscribe requests the mock has seen
//   "injects" - replies with how many thread/inject_items calls the mock saw and the call ids injected into this thread
//   "plan" - sends turn/plan/updated, then the normal reply
//   "compact" - sends a contextCompaction item, then the normal reply
//   "cached" - the normal reply, but reports cached input tokens
//   "reason" - streams reasoning text and summaries plus a command's output, then replies
//   "canonical" - the render-parity event set: a message, a command, a file edit, a message
//   "subagent" - spawns a child thread, asks for a command on it, and closes the Agent row
//   "spawn" - a spawnAgent call whose child id only arrives on item/completed, then the child's reply
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
let unsubscribes = 0;
let injectCalls = 0;
const injected = new Map(); // thread id -> items injected into it
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
      unsubscribes++;
      configs.delete(params.threadId);
      return send({ id, result: { status: "unsubscribed" } });
    case "thread/inject_items": {
      if (!threads.has(params.threadId)) return send({ id, error: { code: -32600, message: "no such thread" } });
      if (!injected.has(params.threadId)) injected.set(params.threadId, []);
      injected.get(params.threadId).push(...params.items);
      injectCalls++;
      return send({ id, result: {} });
    }
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
      if (text === "unsubs") {
        notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id: "m", text: String(unsubscribes) } });
        return done("completed");
      }
      if (text === "injects") {
        const reply = `injects=${injectCalls} ids=${(injected.get(threadId) ?? []).filter((i) => i.call_id && i.type === "function_call_output").map((i) => i.call_id).join(",")}`;
        notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "m2", delta: reply });
        notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id: "m2", text: reply } });
        return done("completed");
      }
      if (text === "canonical") {
        const say = (itemId, reply) => {
          notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId, delta: reply });
          notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id: itemId, text: reply } });
        };
        say("m1", "I'll run the tests.");
        const cmd = { type: "commandExecution", id: "c1", command: "npm test", status: "inProgress", aggregatedOutput: null, exitCode: null };
        notify("item/started", { threadId, turnId: turn.id, item: cmd });
        notify("item/completed", { threadId, turnId: turn.id, item: { ...cmd, status: "completed", aggregatedOutput: "3 passed", exitCode: 0 } });
        // Equal to unifiedDiff("a.txt", "one\n", "uno\n").
        const diff = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+uno\n";
        const file = { type: "fileChange", id: "f1", changes: [{ path: "a.txt", kind: "update", diff }], status: "inProgress" };
        notify("item/started", { threadId, turnId: turn.id, item: file });
        notify("item/completed", { threadId, turnId: turn.id, item: { ...file, status: "completed" } });
        say("m2", "Done.");
        return done("completed");
      }
      if (text === "spawn") {
        const spawn = { type: "collabAgentToolCall", id: "call_sp1", tool: "spawnAgent", status: "inProgress", senderThreadId: threadId, receiverThreadIds: [], prompt: "What is 17*23?", model: null, agentsStates: {} };
        notify("item/started", { threadId, turnId: turn.id, item: spawn });
        notify("item/completed", { threadId, turnId: turn.id, item: { ...spawn, status: "completed", receiverThreadIds: ["child-2"] } });
        notify("item/completed", { threadId: "child-2", turnId: "child-turn", item: { type: "agentMessage", id: "cm2", text: "391" } });
        const finished = { type: "subAgentActivity", id: "subagent-completed-1", kind: "completed", agentThreadId: "child-2", agentPath: "/root/worker" };
        notify("item/completed", { threadId, turnId: turn.id, item: finished });
        return done("completed");
      }
      if (text === "subagent") {
        // The root announces the child thread, which then runs its own turn.
        const childId = "child-1";
        const activity = { type: "subAgentActivity", id: "call_s1", kind: "started", agentThreadId: childId, agentPath: "/root/multiply" };
        notify("item/started", { threadId, turnId: turn.id, item: activity });
        notify("item/completed", { threadId, turnId: turn.id, item: activity });
        const childTurn = { id: "child-turn", status: "inProgress", error: null, durationMs: null, items: [] };
        notify("turn/started", { threadId: childId, turn: childTurn });
        const cmd = { type: "commandExecution", id: "cc1", command: "echo 391", status: "inProgress", aggregatedOutput: null, exitCode: null };
        notify("item/started", { threadId: childId, turnId: childTurn.id, item: cmd });
        const res = await ask("item/commandExecution/requestApproval", { threadId: childId, turnId: childTurn.id, itemId: "cc1", command: "echo 391", startedAtMs: 0 });
        const ok = res.decision === "accept" || res.decision === "acceptForSession";
        notify("item/completed", { threadId: childId, turnId: childTurn.id, item: { ...cmd, status: ok ? "completed" : "declined", aggregatedOutput: ok ? "391" : null, exitCode: ok ? 0 : null } });
        notify("item/agentMessage/delta", { threadId: childId, turnId: childTurn.id, itemId: "cm1", delta: "391" });
        notify("item/completed", { threadId: childId, turnId: childTurn.id, item: { type: "agentMessage", id: "cm1", text: "391" } });
        const childUsage = { inputTokens: 900, cachedInputTokens: 0, outputTokens: 12, totalTokens: 912, reasoningOutputTokens: 0, cacheWriteInputTokens: 0 };
        notify("thread/tokenUsage/updated", { threadId: childId, turnId: childTurn.id, tokenUsage: { last: childUsage, total: {}, modelContextWindow: null } });
        notify("turn/completed", { threadId: childId, turn: { ...childTurn, status: "completed", durationMs: 42 } });
        // The root waits, then the child's completion closes the Agent row.
        const wait = { type: "collabAgentToolCall", id: "call_w1", tool: "wait", status: "inProgress", senderThreadId: threadId, receiverThreadIds: [], prompt: null, model: null, agentsStates: {} };
        notify("item/started", { threadId, turnId: turn.id, item: wait });
        notify("item/completed", { threadId, turnId: turn.id, item: { ...wait, status: "completed" } });
        const finished = { type: "subAgentActivity", id: "subagent-completed-0", kind: "completed", agentThreadId: childId, agentPath: "/root/multiply" };
        notify("item/started", { threadId, turnId: turn.id, item: finished });
        notify("item/completed", { threadId, turnId: turn.id, item: finished });
        notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "m2", delta: "The answer is 391." });
        notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id: "m2", text: "The answer is 391." } });
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
        const server = configs.get(threadId)?.mcp_servers?.cubiq;
        if (!server) {
          notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id: "m", text: "no tools" } });
          return done("completed");
        }
        const args = { expression: "1+1" };
        const item = { type: "mcpToolCall", id: "t1", server: "cubiq", tool: "browser_eval", status: "inProgress", arguments: args, result: null, error: null };
        notify("item/started", { threadId, turnId: turn.id, item });
        let allowed = true;
        if (server.tools?.browser_eval?.approval_mode === "prompt") {
          const res = await ask("mcpServer/elicitation/request", {
            threadId,
            turnId: turn.id,
            serverName: "cubiq",
            mode: "form",
            _meta: { codex_approval_kind: "mcp_tool_call", tool_params_display: [{ name: "expression", value: "1+1", display_name: "expression" }] },
            message: 'Allow the cubiq MCP server to run tool "browser_eval"?',
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
      if (text.startsWith("tool:")) {
        const command = text.slice("tool:".length);
        const item = { type: "commandExecution", id: "c1", command, status: "inProgress", aggregatedOutput: null, exitCode: null };
        notify("item/started", { threadId, turnId: turn.id, item });
        const res = await ask("item/commandExecution/requestApproval", { threadId, turnId: turn.id, itemId: "c1", command, startedAtMs: 0 });
        const ok = res.decision === "accept" || res.decision === "acceptForSession";
        notify("item/completed", { threadId, turnId: turn.id, item: { ...item, status: ok ? "completed" : "declined", aggregatedOutput: ok ? `3 passed (${res.decision})` : null, exitCode: ok ? 0 : null } });
      }
      if (text.startsWith("run:")) {
        const command = text.slice("run:".length);
        const item = { type: "commandExecution", id: "c1", command, status: "inProgress", aggregatedOutput: null, exitCode: null };
        notify("item/started", { threadId, turnId: turn.id, item });
        notify("item/completed", { threadId, turnId: turn.id, item: { ...item, status: "completed", aggregatedOutput: "ok", exitCode: 0 } });
      }
      if (text === "file") {
        const item = { type: "fileChange", id: "f1", changes: [{ path: "a.txt", kind: "update" }], status: "inProgress" };
        notify("item/started", { threadId, turnId: turn.id, item });
        const res = await ask("item/fileChange/requestApproval", { threadId, turnId: turn.id, itemId: "f1", reason: "edit a.txt" });
        const ok = res.decision === "accept" || res.decision === "acceptForSession";
        notify("item/completed", { threadId, turnId: turn.id, item: { ...item, status: ok ? "completed" : "declined" } });
      }
      if (text === "plan") {
        notify("turn/plan/updated", {
          threadId,
          turnId: turn.id,
          explanation: null,
          plan: [
            { step: "Read code", status: "completed" },
            { step: "Fix bug", status: "inProgress" },
            { step: "Test", status: "pending" },
          ],
        });
      }
      if (text === "compact") {
        notify("item/started", { threadId, turnId: turn.id, item: { type: "contextCompaction", id: "cc1" } });
        notify("item/completed", { threadId, turnId: turn.id, item: { type: "contextCompaction", id: "cc1" } });
      }
      if (text === "reason") {
        notify("item/started", { threadId, turnId: turn.id, item: { type: "reasoning", id: "r1", summary: [], content: [] } });
        notify("item/reasoning/textDelta", { threadId, turnId: turn.id, itemId: "r1", contentIndex: 0, delta: "Let me " });
        notify("item/reasoning/textDelta", { threadId, turnId: turn.id, itemId: "r1", contentIndex: 0, delta: "see." });
        notify("item/reasoning/summaryTextDelta", { threadId, turnId: turn.id, itemId: "r1", summaryIndex: 0, delta: "Looking" });
        notify("item/reasoning/summaryPartAdded", { threadId, turnId: turn.id, itemId: "r1", summaryIndex: 1 });
        notify("item/reasoning/summaryTextDelta", { threadId, turnId: turn.id, itemId: "r1", summaryIndex: 1, delta: "Checking" });
        notify("item/completed", {
          threadId,
          turnId: turn.id,
          item: { type: "reasoning", id: "r1", summary: ["Looking", "Checking"], content: [] },
        });
        const cmd = { type: "commandExecution", id: "c2", command: "ls", status: "inProgress", aggregatedOutput: null, exitCode: null };
        notify("item/started", { threadId, turnId: turn.id, item: cmd });
        notify("item/commandExecution/outputDelta", { threadId, turnId: turn.id, itemId: "c2", delta: "a.txt\n" });
        notify("item/completed", { threadId, turnId: turn.id, item: { ...cmd, status: "completed", aggregatedOutput: "a.txt\n", exitCode: 0 } });
      }
      // The "reason" scenario reports its own reasoning item above.
      if (text !== "reason") notify("item/completed", { threadId, turnId: turn.id, item: { type: "reasoning", id: "r1", summary: ["Considering it."], content: [] } });
      notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "m2", delta: "Hi, " });
      notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "m2", delta: text });
      notify("item/completed", { threadId, turnId: turn.id, item: { type: "agentMessage", id: "m2", text: `Hi, ${text}` } });
      const usage =
        text === "cached"
          ? { inputTokens: 9000, cachedInputTokens: 8000, outputTokens: 12, totalTokens: 9012, reasoningOutputTokens: 0, cacheWriteInputTokens: 0 }
          : { inputTokens: 900, cachedInputTokens: 0, outputTokens: 12, totalTokens: 912, reasoningOutputTokens: 0, cacheWriteInputTokens: 0 };
      notify("thread/tokenUsage/updated", { threadId, turnId: turn.id, tokenUsage: { last: usage, total: {}, modelContextWindow: null } });
      // Codex sends these as responses arrive: sparse, account-wide, no threadId.
      notify("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1790000000 }, secondary: null, planType: "plus" } });
      return done("completed");
    }
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } });
  }
});
