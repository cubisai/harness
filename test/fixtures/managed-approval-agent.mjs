// Local protocol peer, not a model/installed agent. It calls only a supplied
// loopback fixture, after the real driver answers its native approval callback.
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const engine = process.argv[2];
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pending = new Map();
let servers = [], prompts = 0, serial = 0;
const request = (method, params) => new Promise((resolve) => { const id = `permission-${++serial}`; pending.set(id, resolve); send({ id, method, params }); });
const record = (result) => { if (process.env.MANAGED_RESULT) writeFileSync(process.env.MANAGED_RESULT, JSON.stringify({ prompts, ...result })); };
async function invoke(name, args) {
  const server = servers.find((s) => s.name === "cubiq");
  if (!server?.url || new URL(server.url).hostname !== "127.0.0.1") throw new Error("Only an owned loopback fixture is allowed");
  const headers = Array.isArray(server.headers) ? Object.fromEntries(server.headers.map((h) => [h.name, h.value])) : server.headers;
  const client = new Client({ name: `${engine}-local-permission-peer`, version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
    return await client.callTool({ name, arguments: args });
  } finally { await client.close(); }
}
async function handle(message) {
  const { id, method, params } = message;
  if (!method) { pending.get(id)?.(message.result); pending.delete(id); return; }
  if (id === undefined) return;
  if (engine === "codex") {
    if (method === "thread/unsubscribe" && process.env.MANAGED_FAIL_CLOSE) return send({ id, error: { code: -32603, message: "Fixture cannot unload" } });
    if (method === "initialize") return send({ id, result: { userAgent: "local-codex-permission-peer" } });
    if (method === "model/list") return send({ id, result: { data: [{ id: "fake", displayName: "Fixture", hidden: false }] } });
    if (method === "thread/start" || method === "thread/resume") {
      servers = Object.entries(params.config?.mcp_servers ?? {}).map(([name, spec]) => ({ name, url: spec.url, headers: spec.http_headers }));
      return send({ id, result: { thread: { id: "wire-thread" } } });
    }
    if (method === "turn/start") {
      const turn = { id: `turn-${++prompts}`, status: "inProgress", error: null, durationMs: null };
      send({ id, result: { turn } }); send({ method: "turn/started", params: { threadId: "wire-thread", turn } });
      if (params.input?.map((p) => p.text ?? "").join("") === "idle") {
        record({ idle: true, servers }); send({ method: "turn/completed", params: { threadId: "wire-thread", turn: { ...turn, status: "completed", durationMs: 1 } } }); return;
      }
      const answer = await request("mcpServer/elicitation/request", { threadId: "wire-thread", serverName: "cubiq", message: 'Run tool "summary"', _meta: { codex_approval_kind: "mcp_tool_call", tool_params_display: [{ name: "day", value: 1 }] } });
      const result = answer?.action === "accept" ? await invoke("summary", { day: 1 }) : { isError: true };
      record({ answer, result });
      send({ method: "turn/completed", params: { threadId: "wire-thread", turn: { ...turn, status: "completed", durationMs: 1 } } }); return;
    }
  } else {
    if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: !process.env.MANAGED_NO_HTTP }, sessionCapabilities: process.env.MANAGED_NO_RESUME ? {} : { resume: {}, close: {} } }, authMethods: [] } });
    if (method === "session/close" && process.env.MANAGED_FAIL_CLOSE) return send({ id, error: { code: -32603, message: "Fixture cannot close" } });
    if (method === "session/new" || method === "session/resume" || method === "session/load") { servers = params.mcpServers; return send({ id, result: { sessionId: "wire-session", configOptions: [] } }); }
    if (method === "session/prompt") {
      prompts++;
      const text = params.prompt.map((p) => p.text ?? "").join("");
      if (text === "idle") { record({ idle: true, servers }); return send({ id, result: { stopReason: "end_turn" } }); }
      const answer = await request("session/request_permission", { sessionId: "wire-session", toolCall: { toolCallId: "tool-1", title: "mcp__cubiq__summary", kind: "other", rawInput: { day: 1 } }, options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "deny", kind: "reject_once", name: "Deny" }] });
      const result = answer?.outcome?.optionId === "once" ? await invoke("summary", { day: 1 }) : { isError: true };
      record({ answer, result }); return send({ id, result: { stopReason: "end_turn" } });
    }
    if (method === "session/cancel") return;
  }
  send({ id, result: {} });
}
createInterface({ input: process.stdin }).on("line", (line) => { let message; try { message = JSON.parse(line); } catch { return; } void handle(message).catch((error) => { record({ error: String(error) }); if (message.id !== undefined) send({ id: message.id, error: { code: -32603, message: String(error) } }); }); });
