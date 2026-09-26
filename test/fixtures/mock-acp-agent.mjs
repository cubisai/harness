// A tiny ACP agent over stdio for tests. The prompt text picks the scenario:
//   "tool"    - asks permission to run a command, then reports the result
//   "slow"    - streams until session/cancel arrives
//   "reason"  - emits three thought chunks, a tick apart, then answers
//   "plan"    - emits a plan update with two entries, then answers
//   "nousage" - answers with a prompt response that carries no usage object
//   "env:NAME" - answers "NAME=present" when the env var is a non-empty string,
//                else "NAME=absent"; never echoes the value
//   other     - answers "Hello, <prompt>"
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
let model = "mock-small";
const sessions = new Set(["resumable-session"]);
let cancelled = false;
let lastMcp = [];
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: model,
    options: [
      { value: "mock-small", name: "Mock Small" },
      { value: "mock-large", name: "Mock Large" },
    ],
  },
];

console.log("not json: agents sometimes log to stdout");

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
      return send({
        id,
        result: {
          protocolVersion: 1,
          // MOCK_ACP_NO_HTTP=1 simulates an agent release that dropped HTTP MCP,
          // so a test can watch initialize turn the capability back off.
          agentCapabilities: {
            sessionCapabilities: { resume: {}, close: {} },
            ...(process.env.MOCK_ACP_NO_HTTP === "1" ? {} : { mcpCapabilities: { http: true } }),
          },
          agentInfo: { name: "mock", version: "1" },
          authMethods: [],
        },
      });
    case "session/new": {
      const sessionId = `s-${sessions.size}`;
      sessions.add(sessionId);
      lastMcp = params.mcpServers;
      return send({ id, result: { sessionId, configOptions: configOptions() } });
    }
    case "session/close":
      return send({ id, result: {} });
    case "session/resume":
      if (!sessions.has(params.sessionId)) return send({ id, error: { code: -32002, message: "unknown session" } });
      lastMcp = params.mcpServers ?? [];
      return send({ id, result: { configOptions: configOptions() } });
    case "session/set_config_option":
      model = params.value;
      return send({ id, result: { configOptions: configOptions() } });
    case "session/cancel":
      cancelled = true;
      return;
    case "session/prompt": {
      const sid = params.sessionId;
      const text = params.prompt.map((b) => b.text).join("");
      cancelled = false;
      // "reason" emits its own three thought chunks below; every other scenario
      // gets this one shared chunk.
      if (text !== "reason") update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      if (text === "tool") {
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Running it." } });
        update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "npm test", kind: "execute", status: "pending" });
        const res = await ask("session/request_permission", {
          sessionId: sid,
          toolCall: { toolCallId: "t1", title: "npm test", kind: "execute" },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        });
        const allowed = res.outcome.outcome === "selected" && res.outcome.optionId !== "no";
        // An intermediate progress update, before the terminal one below.
        update(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "in_progress",
          content: [{ type: "content", content: { type: "text", text: "running" } }],
        });
        update(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: allowed ? "completed" : "failed",
          content: [{ type: "content", content: { type: "text", text: allowed ? `3 passed (${res.outcome.optionId})` : "rejected" } }],
        });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All done." } });
      } else if (text === "mcp") {
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(lastMcp.map((m) => [m.type, m.name, m.url])) } });
      } else if (text === "reason") {
        for (const chunk of ["wait", "let me think", "aha"]) {
          update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk } });
          await new Promise((r) => setTimeout(r, 0));
        }
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Hello, ${text} ` } });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `(${model})` } });
      } else if (text === "slow") {
        while (!cancelled) {
          update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
          await new Promise((r) => setTimeout(r, 20));
        }
        return send({ id, result: { stopReason: "cancelled" } });
      } else if (text.startsWith("env:")) {
        const name = text.slice(4);
        const value = process.env[name];
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${name}=${typeof value === "string" && value.length > 0 ? "present" : "absent"}` } });
      } else {
        if (text === "plan") {
          update(sid, {
            sessionUpdate: "plan",
            entries: [
              { content: "Read the code", priority: "high", status: "completed" },
              { content: "Write the fix", priority: "medium", status: "pending" },
            ],
          });
        }
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Hello, ${text} ` } });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `(${model})` } });
      }
      update(sid, { sessionUpdate: "usage_update", used: 1234, size: 100000, cost: { amount: 0.01, currency: "USD" } });
      // "nousage" omits the response usage so the driver must not fall back to
      // the usage_update `used` (context occupancy) for the turn's input count.
      const result = text === "nousage" ? { stopReason: "end_turn" } : { stopReason: "end_turn", usage: { inputTokens: 1200, outputTokens: 34 } };
      return send({ id, result });
    }
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } });
  }
});
