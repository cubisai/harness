// A stand-in for Antigravity's `agy` CLI in print mode with stream-json, in the
// shapes agy 2026-09 printed. The scenario comes from the prompt text; the
// argv and the raw stdin line are echoed in the init event for assertions.
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (argv[0] === "models") {
  process.stdout.write("Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n");
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
let raw = null;
lines.on("line", (line) => {
  if (raw === null) raw = line;
});
lines.on("close", () => {
  const message = JSON.parse(raw ?? "{}");
  const prompt = message?.message?.content ?? "";
  const convIndex = argv.indexOf("--conversation");
  const conversation_id = convIndex >= 0 ? argv[convIndex + 1] : "conv-1";
  out({ event: "init", conversation_id, init: { cwd: process.cwd(), tools: ["run_command"], permission_mode: "request-review", argv, stdin: raw } });
  const step = (s) => out({ event: "step_update", step_update: { conversation_id, ...s } });
  const usage = { input_tokens: 100, output_tokens: 7, thinking_tokens: 3, cache_read_tokens: 40, total_tokens: 107 };
  const last = prompt.split("\n").pop();
  if (last === "fail") {
    process.stderr.write("something broke\n");
    out({ event: "result", result: { conversation_id, status: "ERROR", response: "", usage } });
    process.exit(1);
  }
  if (last === "silent") process.exit(3);
  if (last === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  step({ step_index: 0, state: "DONE", step_type: "user_input" });
  if (last === "echo") {
    step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: JSON.stringify({ argv, stdin: raw }) });
    out({ event: "result", result: { conversation_id, status: "SUCCESS", response: "", usage } });
    return;
  }
  if (last === "tool") {
    step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "Writing it." });
    const file = `${process.cwd()}${process.platform === "win32" ? "\\" : "/"}hello.txt`;
    const w = { name: "write_to_file", parameters: { TargetFile: file } };
    step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: w });
    step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: w });
    const r = { name: "run_command", parameters: { CommandLine: "dir hello.txt" } };
    step({ step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: r });
    step({ step_index: 3, state: "ERROR", step_type: "tool", tool_name: "run_command", tool_info: { ...r, error: { type: "TOOL_ERROR", message: "user denied permission to run command" } } });
    out({ event: "result", result: { conversation_id, status: "SUCCESS", response: "Writing it.", usage, denied_actions: [{ action: "command", display_name: "RunCommand" }] } });
    return;
  }
  step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Hel" });
  step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "lo\n", usage });
  out({ event: "result", result: { conversation_id, status: "SUCCESS", response: "Hello\n", usage } });
});
