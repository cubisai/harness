import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "../src/shared/types";
import { createTaskTool, EXPLORE_PROMPT, SUBAGENT_MAX_STEPS, SUBAGENT_RESULT_CHARS } from "../src/main/harness/subagent";
import type { LoopTool } from "../src/main/harness/loop";
import type { Route, streamLlm } from "../src/main/harness/llm/client";
import { LlmError, emptyUsage, type AssistantPart, type LlmEvent, type LlmRequest, type LlmUsage } from "../src/main/harness/llm/types";

const route: Route = { protocol: "openai-chat", url: "http://x", headers: {}, label: "TokenHarbor", key: null };
const usage = (input: number): LlmUsage => ({ ...emptyUsage(), inputTokens: input, outputTokens: 5 });
const text = (t: string): AssistantPart[] => [{ type: "text", text: t }];
const call = (id: string, name: string, input: Record<string, unknown> = {}): AssistantPart => ({ type: "tool-call", id, name, input });

/** A fake model: each call answers with the next scripted message (after streaming its text). */
function script(...answers: (AssistantPart[] | ((req: LlmRequest) => AssistantPart[]))[]) {
  const requests: LlmRequest[] = [];
  const stream = async function* (_r: Route, req: LlmRequest, opts?: { signal?: AbortSignal }): AsyncGenerator<LlmEvent> {
    requests.push({ ...req, messages: [...req.messages] });
    const a = answers[Math.min(requests.length - 1, answers.length - 1)]!;
    const message = typeof a === "function" ? a(req) : a;
    for (const p of message) if (p.type === "text") yield { type: "text-delta", text: p.text };
    if (opts?.signal?.aborted) throw new LlmError("Stopped.", "aborted");
    const calls = message.some((p) => p.type === "tool-call");
    yield { type: "finish", reason: calls ? "tool-calls" : "stop", message, usage: usage(10) };
  };
  return { stream: stream as typeof streamLlm, requests };
}

function tool(name: string, access: LoopTool["access"], run: LoopTool["run"] = async () => ({ text: `${name} ok` })): LoopTool {
  return { definition: { name, description: name, parameters: { type: "object", properties: {} } }, displayName: name.toUpperCase(), access, summarize: (a) => String(a.path ?? name), run };
}

function setup(answers: (AssistantPart[] | ((req: LlmRequest) => AssistantPart[]))[], over: Partial<Parameters<typeof createTaskTool>[0]> = {}) {
  const events: ThreadEvent[] = [];
  const usages: LlmUsage[] = [];
  const s = script(...answers);
  const task = createTaskTool({
    route,
    request: { model: "m" },
    tools: () => [],
    cwd: "/work",
    emit: (e) => events.push(e),
    onUsage: (u) => usages.push(u),
    stream: s.stream,
    ...over,
  });
  const run = (args: Record<string, unknown>, id = "call1", signal = new AbortController().signal) => task.run(args, { id, signal, onOutput: () => {} });
  return { task, events, usages, requests: s.requests, run };
}

describe("createTaskTool", () => {
  it("advertises the task tool and the explore subagent type", () => {
    const { task } = setup([]);
    expect(task.definition.name).toBe("task");
    expect(task.displayName).toBe("Agent");
    expect(task.access).toBe("read");
    expect(task.definition.parameters).toMatchObject({
      type: "object",
      properties: { description: { type: "string" }, prompt: { type: "string" } },
      required: ["description", "prompt"],
    });
    expect(task.summarize({ description: "find the loop" })).toBe("find the loop");
    expect(task.summarize({})).toBe("Explore");
    expect(task.inputPayload?.({ prompt: "find X" })).toEqual({ prompt: "find X", subagent_type: "explore" });
  });

  it("runs read-only tools and returns the child's last text", async () => {
    const read = tool("read", "read", async (args) => ({ text: `contents of ${String(args.path)}` }));
    const t = setup([[call("r1", "read", { path: "a.ts" })], text("Found it at a.ts:1")], { tools: () => [read] });
    const result = await t.run({ description: "find the loop", prompt: "Where is the loop?" });
    expect(result).toEqual({ text: "Found it at a.ts:1" });
    expect(t.requests[0]!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Where is the loop?" }] }]);
    expect(t.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", results: [{ callId: "r1", text: "contents of a.ts" }] });
  });

  it("carries every child event under the call's id as parentId", async () => {
    const read = tool("read", "read", async () => ({ text: "ok" }));
    const t = setup([[call("r1", "read", { path: "a.ts" })], text("done")], { tools: () => [read] });
    await t.run({ description: "x", prompt: "go" });
    expect(t.events.map((e) => e.kind)).toEqual(["tool-use", "tool-result", "assistant-text"]);
    expect(t.events.every((e) => e.parentId === "call1")).toBe(true);
  });

  it("streams the child's live text under the call's id, never as the parent's", async () => {
    const live: string[] = [];
    const t = setup([text("streamed answer")], {
      live: {
        text: (txt, itemId, parentId) => live.push(`${parentId}|${itemId}|${txt}`),
        reasoning: () => {},
        toolOutput: () => {},
      },
    });
    await t.run({ description: "x", prompt: "go" }, "call7");
    expect(live).toEqual(["call7|call7-sub-0-t|streamed answer"]);
    // The stored reply carries the same item id, so the live item closes when it lands.
    expect(t.events.find((e) => e.kind === "assistant-text")).toMatchObject({ itemId: "call7-sub-0-t", parentId: "call7" });
  });

  it("filters out edit-access and nested task tools from the child's request", async () => {
    const tools = [tool("read", "read"), tool("edit", "edit"), tool("bash", "shell"), tool("task", "read")];
    const t = setup([text("done")], { tools: () => tools });
    await t.run({ description: "x", prompt: "go" });
    expect(t.requests[0]!.tools.map((x) => x.name)).toEqual(["read"]);
  });

  it("gives the child EXPLORE_PROMPT first and its working folder second", async () => {
    const t = setup([text("done")], { cwd: "/work/project" });
    await t.run({ description: "x", prompt: "go" });
    expect(t.requests[0]!.system[0]).toBe(EXPLORE_PROMPT);
    expect(t.requests[0]!.system[1]).toBe("Working folder: /work/project");
  });

  it("reports the child's usage to onUsage", async () => {
    const t = setup([text("done")]);
    const result = await t.run({ description: "x", prompt: "go" });
    expect(result).toEqual({ text: "done" });
    expect(t.usages).toEqual([usage(10)]);
  });

  it("prefixes the report when the child hits the step limit", async () => {
    const read = tool("read", "read", async () => ({ text: "ok" }));
    const t = setup([[call("r1", "read", { path: "a.ts" })]], { tools: () => [read] });
    const result = await t.run({ description: "x", prompt: "go" });
    expect(result.text.startsWith("(Stopped at the step limit.) ")).toBe(true);
    expect(t.requests).toHaveLength(SUBAGENT_MAX_STEPS);
  });

  it("reports a stop as an error result", async () => {
    const abort = new AbortController();
    abort.abort();
    const t = setup([text("never")]);
    const result = await t.run({ description: "x", prompt: "go" }, "call1", abort.signal);
    expect(result).toEqual({ text: "Interrupted by the user.", isError: true });
  });

  it("cuts a long report and says so", async () => {
    const t = setup([text("x".repeat(SUBAGENT_RESULT_CHARS + 100))]);
    const result = await t.run({ description: "x", prompt: "go" });
    expect(result.text.length).toBe(SUBAGENT_RESULT_CHARS + "\n…[report cut]".length);
    expect(result.text.endsWith("\n…[report cut]")).toBe(true);
  });

  it("reports a subagent failure and an empty prompt as errors", async () => {
    const failing = { stream: (async function* () {
      throw new LlmError("TokenHarbor: bad key.", "auth", 401);
    }) as typeof streamLlm };
    const t = setup([], { stream: failing.stream });
    expect(await t.run({ description: "x", prompt: "go" })).toEqual({ text: "The subagent failed: TokenHarbor: bad key.", isError: true });

    const empty = setup([]);
    expect(await empty.run({ description: "x", prompt: "  " })).toMatchObject({ isError: true });
  });
});
