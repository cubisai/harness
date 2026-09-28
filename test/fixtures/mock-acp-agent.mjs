// A tiny ACP agent over stdio for tests. The prompt text picks the scenario:
//   "tool"    - asks permission to run a command, then reports the result
//   "exec:<command>" - asks permission to execute <command> (toolCall kind
//                "execute" with rawInput.command), then answers "ran" when an
//                allow option was chosen, "rejected:<optionKind>" for a reject,
//                or "cancelled" when no option was selected
//   "slow"    - streams until session/cancel arrives
//   "reason"  - emits three thought chunks, a tick apart, then answers
//   "plan"    - emits a plan update with two entries, then answers
//   "nousage" - answers with a prompt response that carries no usage object
//   "env:NAME" - answers "NAME=present" when the env var is a non-empty string,
//                else "NAME=absent"; never echoes the value
//   "config"  - answers with the "agent" section of OPENCODE_CONFIG_CONTENT, or "none"
//   "canonical" - the render-parity event set: a message, a command, a file edit, a message
//   "canonical-opencode" - the same, titled the way OpenCode titles its calls ("bash", "edit")
//   "phantom-permission" - Antigravity's two-id tool flow: permission under "perm-hash-1",
//                the real call under "<sid>:1" (completed), then a phantom "failed"
//                update under "perm-hash-1" after it succeeded
//   "needs-auth" (with MOCK_ACP_NEEDS_AUTH=1) - initialize advertises a Google sign-in
//                method, session/new fails -32000 until authenticate is received (its
//                link printed on stderr), and the retried session/new then succeeds
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
let thoughtLevel = "medium";
let configSets = 0;
// MOCK_ACP_NEEDS_AUTH=1: a signed-out profile. initialize advertises the sign-in
// method and session/new answers -32000 until authenticate has been received.
const needsAuth = process.env.MOCK_ACP_NEEDS_AUTH === "1";
let authed = false;
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
  // MOCK_ACP_OPENCODE=1 reports a mode select like OpenCode's, so a test can
  // watch reasoning variants be written under agent.<mode>.
  ...(process.env.MOCK_ACP_OPENCODE === "1"
    ? [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          category: "mode",
          currentValue: "build",
          options: [
            { value: "build", name: "Build" },
            { value: "plan", name: "Plan" },
          ],
        },
      ]
    : []),
  // MOCK_ACP_EFFORT=1 adds the thought-level select so a test can watch effort
  // be set through session/set_config_option.
  ...(process.env.MOCK_ACP_EFFORT === "1"
    ? [
        {
          id: "thought_level",
          name: "Thinking",
          type: "select",
          category: "thought_level",
          currentValue: thoughtLevel,
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ]
    : []),
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
          authMethods: needsAuth ? [{ id: "oauth-personal", name: "Log in with Google" }] : [],
        },
      });
    case "authenticate":
      // The sign-in link goes to stderr, the way Google's server prints it. The
      // small pause lets the parent read that line before this response lands, so
      // the driver's onStderrLine has recorded it by the time authenticate returns.
      process.stderr.write("Open the following link to authenticate the ACP server: https://example.com/sign-in?x=1\n");
      await new Promise((r) => setTimeout(r, 50));
      authed = true;
      return send({ id, result: {} });
    case "session/new": {
      if (needsAuth && !authed) return send({ id, error: { code: -32000, message: "Authentication required" } });
      const sessionId = `s-${sessions.size}`;
      sessions.add(sessionId);
      lastMcp = params.mcpServers;
      return send({ id, result: { sessionId, configOptions: configOptions() } });
    }
    case "session/close":
      return send({ id, result: {} });
    case "session/resume":
      // OpenCode persists its sessions, so in OpenCode mode a session this mock
      // created is resumable even in a fresh process (a respawn after a variant change).
      if (!sessions.has(params.sessionId) && !(process.env.MOCK_ACP_OPENCODE === "1" && /^s-\d+$/.test(params.sessionId))) {
        return send({ id, error: { code: -32002, message: "unknown session" } });
      }
      lastMcp = params.mcpServers ?? [];
      return send({ id, result: { configOptions: configOptions() } });
    case "session/set_config_option":
      if (params.configId === "model") model = params.value;
      else if (params.configId === "thought_level") {
        thoughtLevel = params.value;
        configSets++;
      }
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
      if (text === "canonical" || text === "canonical-opencode") {
        // OpenCode titles a call with its tool's name and names the file in rawInput.
        const opencode = text === "canonical-opencode";
        const say = (t) => update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
        say("I'll run the tests.");
        update(sid, { sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", title: opencode ? "bash" : "npm test", rawInput: { command: "npm test" }, status: "pending" });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "3 passed" } }] });
        update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: "f1",
          kind: "edit",
          status: "pending",
          ...(opencode ? { title: "edit", rawInput: { filePath: "a.txt" } } : { title: "a.txt", locations: [{ path: "a.txt" }] }),
        });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "f1", status: "completed", content: [{ type: "diff", path: "a.txt", oldText: "one\n", newText: "uno\n" }] });
        say("Done.");
      } else if (text === "late-input") {
        // OpenCode: the first tool_call has no arguments; they come on a later update.
        update(sid, { sessionUpdate: "tool_call", toolCallId: "l1", title: "bash", kind: "execute", rawInput: {}, status: "pending" });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "l1", rawInput: { command: "npm test" }, status: "in_progress" });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "l1", status: "completed", content: [{ type: "content", content: { type: "text", text: "3 passed" } }] });
        update(sid, { sessionUpdate: "tool_call", toolCallId: "l2", title: "cubiq_browser_open", kind: "other", rawInput: {}, status: "pending" });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "l2", rawInput: { url: "https://example.com" }, status: "in_progress" });
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "l2", status: "completed", content: [{ type: "content", content: { type: "text", text: "Page: Example Domain" } }] });
      } else if (text === "phantom-permission") {
        // Antigravity asks permission under one id and runs the call under another,
        // then sends a terminal "failed" update under the permission id even though
        // the call succeeded. The driver must ignore that second one.
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Editing." } });
        await ask("session/request_permission", {
          sessionId: sid,
          toolCall: { toolCallId: "perm-hash-1", kind: "edit", title: "create a.txt" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        });
        update(sid, { sessionUpdate: "tool_call", toolCallId: `${sid}:1`, kind: "edit", status: "pending" });
        update(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: `${sid}:1`,
          status: "completed",
          content: [{ type: "diff", path: "a.txt", oldText: "", newText: "hello\n" }],
        });
        update(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: "perm-hash-1",
          status: "failed",
          rawOutput: "Tool call was approved but never executed.",
        });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
      } else if (text === "tool") {
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
      } else if (text.startsWith("exec:")) {
        const command = text.slice("exec:".length);
        const options = [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "allow-always", name: "Always", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
        ];
        const res = await ask("session/request_permission", {
          sessionId: sid,
          toolCall: { toolCallId: "e1", title: command, kind: "execute", rawInput: { command } },
          options,
        });
        let answer;
        if (res?.outcome?.outcome !== "selected") answer = "cancelled";
        else {
          const kind = options.find((o) => o.optionId === res.outcome.optionId)?.kind ?? res.outcome.optionId;
          answer = kind === "allow_once" || kind === "allow_always" ? "ran" : `rejected:${kind}`;
        }
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
      } else if (text === "mcp") {
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(lastMcp.map((m) => [m.type, m.name, m.url])) } });
      } else if (text === "reason") {
        for (const chunk of ["wait", "let me think", "aha"]) {
          update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: chunk } });
          await new Promise((r) => setTimeout(r, 0));
        }
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Hello, ${text} ` } });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `(${model})` } });
      } else if (text === "effort") {
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `sets=${configSets}` } });
      } else if (text === "config") {
        // Reports only the "agent" section, so a test never sees a provider key.
        let answer = "none";
        const raw = process.env.OPENCODE_CONFIG_CONTENT;
        if (raw) {
          try {
            const config = JSON.parse(raw);
            if (config && config.agent) answer = JSON.stringify(config.agent);
          } catch {
            answer = "none";
          }
        }
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
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
