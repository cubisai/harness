import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "../src/shared/types";
import { REPEAT_FAIL_NOTE, UNBACKED_PASS_NOTE, runLoop, runsInParallel, type LoopInput, type LoopTool } from "../src/main/harness/loop";
import { decide, refusal } from "../src/main/harness/permissions";
import type { Route } from "../src/main/harness/llm/client";
import { LlmError, emptyUsage, type AssistantPart, type LlmEvent, type LlmMessage, type LlmRequest } from "../src/main/harness/llm/types";
import { ToolError } from "../src/main/harness/tools/types";

const route: Route = { protocol: "openai-chat", url: "http://x", headers: {}, label: "TokenHarbor", key: null };
const usage = (input: number) => ({ ...emptyUsage(), inputTokens: input, outputTokens: 5 });
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
  return { stream: stream as LoopInput["stream"], requests };
}

function tool(name: string, access: LoopTool["access"], run: LoopTool["run"] = async () => ({ text: `${name} ok` }), parallel?: boolean): LoopTool {
  return {
    definition: { name, description: name, parameters: { type: "object", properties: {} } },
    displayName: name.toUpperCase(),
    access,
    ...(parallel === undefined ? {} : { parallel }),
    summarize: (a) => String(a.path ?? name),
    run,
  };
}

function setup(over: Partial<LoopInput> & { stream: LoopInput["stream"] }) {
  const events: ThreadEvent[] = [];
  const deltas: string[] = [];
  const stored: LlmMessage[] = [];
  const messages: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  const input: LoopInput = {
    route,
    request: { model: "m", system: ["sys"] },
    messages,
    tools: [],
    signal: new AbortController().signal,
    turnId: "t1",
    authorize: async () => ({ ok: true }),
    emit: { event: (e) => events.push(e), textDelta: (t) => deltas.push(t), reasoningDelta: () => {}, toolInputDelta: () => {}, toolOutputDelta: () => {}, usage: () => {} },
    onMessage: (m) => stored.push(m),
    ...over,
  };
  return { input, events, deltas, stored, messages };
}

describe("runLoop", () => {
  it("ends on an answer without tools", async () => {
    const s = script(text("Hello"));
    const { input, events, deltas, stored } = setup({ stream: s.stream });
    const r = await runLoop(input);
    expect(r).toMatchObject({ stop: "done", steps: 1, usage: { inputTokens: 10 } });
    expect(deltas).toEqual(["Hello"]);
    expect(events).toEqual([{ kind: "assistant-text", text: "Hello", itemId: "t1-0-t" }]);
    expect(stored).toEqual([{ role: "assistant", content: text("Hello") }]);
  });

  it("runs a tool, feeds the result back and continues", async () => {
    const s = script([call("c1", "read", { path: "a.ts" })], text("Done"));
    const read = tool("read", "read", async (args) => ({ text: `contents of ${String(args.path)}`, display: { summary: "a.ts" } }));
    const { input, events, messages } = setup({ stream: s.stream, tools: [read] });
    const r = await runLoop(input);
    expect(r).toMatchObject({ stop: "done", steps: 2, usage: { inputTokens: 20 } });
    expect(events.map((e) => e.kind)).toEqual(["tool-use", "tool-result", "assistant-text"]);
    expect(events[0]).toMatchObject({ toolUseId: "c1", name: "READ", summary: "a.ts", payload: { path: "a.ts" } });
    expect(events[1]).toMatchObject({ toolUseId: "c1", isError: false, payload: "contents of a.ts" });
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(s.requests[1]!.messages.at(-1)).toEqual({ role: "tool", results: [{ callId: "c1", name: "read", text: "contents of a.ts" }] });
    expect(s.requests[0]!.tools.map((t) => t.name)).toEqual(["read"]);
  });

  it("runs read-only calls together and edits one at a time, results in call order", async () => {
    let active = 0;
    let peak = 0;
    const slow = (name: string, access: LoopTool["access"]) =>
      tool(name, access, async (args) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { text: `${name}:${String(args.n)}` };
      });
    const s = script([call("a", "read", { n: 1 }), call("b", "read", { n: 2 }), call("c", "read", { n: 3 }), call("d", "edit", { n: 4 }), call("e", "edit", { n: 5 })], text("ok"));
    const { input, messages } = setup({ stream: s.stream, tools: [slow("read", "read"), slow("edit", "edit")] });
    await runLoop(input);
    expect(peak).toBe(3);
    const results = (messages[2] as Extract<LlmMessage, { role: "tool" }>).results;
    expect(results.map((r) => r.text)).toEqual(["read:1", "read:2", "read:3", "edit:4", "edit:5"]);
  });

  it("never overlaps read calls marked not parallel, and keeps their order", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const serial = tool(
      "read",
      "read",
      async (args) => {
        order.push(`start:${String(args.n)}`);
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        order.push(`end:${String(args.n)}`);
        return { text: `read:${String(args.n)}` };
      },
      false,
    );
    const s = script([call("a", "read", { n: 1 }), call("b", "read", { n: 2 }), call("c", "read", { n: 3 })], text("ok"));
    const { input, messages } = setup({ stream: s.stream, tools: [serial] });
    await runLoop(input);
    expect(peak).toBe(1);
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
    const results = (messages[2] as Extract<LlmMessage, { role: "tool" }>).results;
    expect(results.map((r) => r.text)).toEqual(["read:1", "read:2", "read:3"]);
  });

  it("overlaps an edit marked parallel with read calls", async () => {
    let active = 0;
    let peak = 0;
    const slow = (name: string, access: LoopTool["access"], parallel?: boolean) =>
      tool(
        name,
        access,
        async (args) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
          return { text: `${name}:${String(args.n)}` };
        },
        parallel,
      );
    const s = script([call("a", "edit", { n: 1 }), call("b", "read", { n: 2 }), call("c", "read", { n: 3 })], text("ok"));
    const { input, messages } = setup({ stream: s.stream, tools: [slow("edit", "edit", true), slow("read", "read")] });
    await runLoop(input);
    expect(peak).toBe(3);
    const results = (messages[2] as Extract<LlmMessage, { role: "tool" }>).results;
    expect(results.map((r) => r.text)).toEqual(["edit:1", "read:2", "read:3"]);
  });

  it("reports refusals, unknown tools, bad JSON and tool errors to the model", async () => {
    const s = script(
      [
        call("a", "edit"),
        call("b", "nope"),
        { type: "tool-call", id: "c", name: "read", input: {}, invalidInput: "{oops" },
        call("d", "boom"),
      ],
      text("ok"),
    );
    const boom = tool("boom", "other", async () => {
      throw new ToolError("No such file: x");
    });
    const { input, events, messages } = setup({
      stream: s.stream,
      tools: [tool("edit", "edit"), tool("read", "read"), boom],
      authorize: async (t) => (t.access === "edit" ? { ok: false, reason: "The user denied this call." } : { ok: true }),
    });
    await runLoop(input);
    const results = (messages[2] as Extract<LlmMessage, { role: "tool" }>).results;
    expect(results.map((r) => r.isError)).toEqual([true, true, true, true]);
    expect(results[0]!.text).toContain("denied");
    expect(results[1]!.text).toContain('no tool named "nope"');
    expect(results[2]!.text).toContain("valid JSON");
    expect(results[3]!.text).toBe("No such file: x");
    expect(events.filter((e) => e.kind === "tool-result").every((e) => (e as { isError: boolean }).isError)).toBe(true);
  });

  it("breaks a doom loop on the third identical call", async () => {
    const s = script([call("a", "read", { path: "x" })], [call("b", "read", { path: "x" })], [call("c", "read", { path: "x" })], text("ok"));
    const runs: string[] = [];
    const { input, messages } = setup({ stream: s.stream, tools: [tool("read", "read", async () => (runs.push("r"), { text: "same" }))] });
    await runLoop(input);
    expect(runs).toHaveLength(2);
    const third = messages[6] as Extract<LlmMessage, { role: "tool" }>;
    expect(third.results[0]!.text).toMatch(/3 times in a row/);
  });

  it("keeps the partial answer on Stop and closes every open call", async () => {
    const abort = new AbortController();
    const s = script(text("Half an ans"));
    abort.abort();
    const one = setup({ stream: s.stream, signal: abort.signal });
    // Aborted before the first step: nothing runs.
    expect(await runLoop(one.input)).toMatchObject({ stop: "stopped", steps: 0 });

    const mid = new AbortController();
    const s2 = script([call("a", "edit", { n: 1 }), call("b", "edit", { n: 2 })]);
    const two = setup({
      stream: s2.stream,
      signal: mid.signal,
      tools: [tool("edit", "edit", async () => (mid.abort(), { text: "edited" }))],
    });
    expect(await runLoop(two.input)).toMatchObject({ stop: "stopped" });
    const results = (two.messages[2] as Extract<LlmMessage, { role: "tool" }>).results;
    expect(results.map((r) => r.text)).toEqual(["edited", "Interrupted by the user."]);

    const s3 = { stream: (async function* () {
      yield { type: "text-delta", text: "partial" } as LlmEvent;
      throw new LlmError("Stopped.", "aborted");
    }) as LoopInput["stream"] };
    const three = setup({ stream: s3.stream });
    expect(await runLoop(three.input)).toMatchObject({ stop: "stopped", steps: 1 });
    expect(three.messages.at(-1)).toEqual({ role: "assistant", content: text("partial") });
    expect(three.events).toEqual([{ kind: "assistant-text", text: "partial", itemId: "t1-0-t" }]);
  });

  it("stops at the step limit and at the output limit with a notice", async () => {
    const s = script([call("a", "read", { n: Math.random() })], [call("b", "read", { n: Math.random() })]);
    const { input, events } = setup({ stream: s.stream, tools: [tool("read", "read")], maxSteps: 2 });
    expect(await runLoop(input)).toMatchObject({ stop: "max-steps", steps: 2 });
    expect(events.at(-1)).toMatchObject({ kind: "notice" });

    const cut = { stream: (async function* () {
      yield { type: "finish", reason: "length", message: text("trunc"), usage: usage(1) } as LlmEvent;
    }) as LoopInput["stream"] };
    const two = setup({ stream: cut.stream });
    expect(await runLoop(two.input)).toMatchObject({ stop: "length" });
    expect(two.events.at(-1)).toMatchObject({ kind: "notice", text: expect.stringMatching(/output limit/) });
  });

  it("treats a prepare that aborts as a clean stop", async () => {
    const s = script(text("never"));
    const { input, events } = setup({
      stream: s.stream,
      prepare: async () => {
        throw new LlmError("Stopped.", "aborted");
      },
    });
    expect(await runLoop(input)).toMatchObject({ stop: "stopped", steps: 0 });
    expect(events).toEqual([]);
  });

  it("lets other model errors through", async () => {
    const failing = { stream: (async function* () {
      throw new LlmError("TokenHarbor: bad key.", "auth", 401);
    }) as LoopInput["stream"] };
    await expect(runLoop(setup({ stream: failing.stream }).input)).rejects.toMatchObject({ kind: "auth" });
  });

  it("runs prepare before each step and uses the in-place replacement it makes", async () => {
    const s = script([call("c1", "read", { path: "a" })], text("done"));
    const prepared: number[] = [];
    let n = 0;
    const { input, messages } = setup({
      stream: s.stream,
      tools: [tool("read", "read")],
      prepare: async (msgs) => {
        prepared.push(++n);
        if (n === 1) msgs.splice(0, msgs.length, { role: "user", content: [{ type: "text", text: "prepared" }] });
      },
    });
    await runLoop(input);
    expect(prepared).toEqual([1, 2]);
    expect(s.requests[0]!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "prepared" }] }]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("retries a step once after an overflow when onOverflow asks", async () => {
    let calls = 0;
    const requests: LlmRequest[] = [];
    const stream = (async function* (_r: Route, req: LlmRequest): AsyncGenerator<LlmEvent> {
      requests.push(req);
      calls++;
      if (calls === 1) throw new LlmError("too long", "overflow", 400);
      yield { type: "finish", reason: "stop", message: text("recovered"), usage: usage(10) };
    }) as LoopInput["stream"];
    const seen: LlmMessage[][] = [];
    const { input, events } = setup({ stream, onOverflow: async (m) => (seen.push([...m]), true) });
    const r = await runLoop(input);
    expect(r).toMatchObject({ stop: "done", steps: 1 });
    expect(seen).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(events).toEqual([{ kind: "assistant-text", text: "recovered", itemId: "t1-0-t" }]);
  });

  it("rethrows a second overflow instead of retrying again", async () => {
    let calls = 0;
    const stream = (async function* (): AsyncGenerator<LlmEvent> {
      calls++;
      throw new LlmError("still too long", "overflow", 400);
    }) as LoopInput["stream"];
    let overflowCalls = 0;
    const { input } = setup({ stream, onOverflow: async () => (overflowCalls++, true) });
    await expect(runLoop(input)).rejects.toMatchObject({ kind: "overflow" });
    expect(overflowCalls).toBe(1);
    expect(calls).toBe(2);
  });

  it("does not retry an overflow after a text delta streamed", async () => {
    const stream = (async function* (): AsyncGenerator<LlmEvent> {
      yield { type: "text-delta", text: "partial" };
      throw new LlmError("too long", "overflow", 400);
    }) as LoopInput["stream"];
    let overflowCalls = 0;
    const { input } = setup({ stream, onOverflow: async () => (overflowCalls++, true) });
    await expect(runLoop(input)).rejects.toMatchObject({ kind: "overflow" });
    expect(overflowCalls).toBe(0);
  });
});

describe("nudges", () => {
  // Three identical failing bash calls with a read between each, so the doom
  // detector (identical calls in a row) never fires.
  const repeatFail = () =>
    script(
      [call("a", "bash", { command: "x" })],
      [call("b", "read", { path: "y" })],
      [call("c", "bash", { command: "x" })],
      [call("d", "read", { path: "y" })],
      [call("e", "bash", { command: "x" })],
      text("done"),
    );
  const repeatFailTools = (): LoopTool[] => [
    tool("bash", "shell", async () => ({ text: "boom", isError: true })),
    tool("read", "read"),
  ];
  /** The texts the loop fed back for the failing bash calls, in order. */
  const bashTexts = (messages: LlmMessage[]) =>
    messages
      .filter((m): m is Extract<LlmMessage, { role: "tool" }> => m.role === "tool")
      .map((m) => m.results[0]?.text ?? "")
      .filter((t) => t.startsWith("boom"));

  it("leaves the old behaviour alone when the flag is off", async () => {
    const s = script(text("All tests pass."));
    const { input, events } = setup({ stream: s.stream });
    expect(await runLoop(input)).toMatchObject({ stop: "done", steps: 1 });
    expect(s.requests).toHaveLength(1);
    expect(events.filter((e) => e.kind === "notice")).toEqual([]);
  });

  it("continues with one corrective user message when the flag is on", async () => {
    const s = script(text("All tests pass."));
    const { input, events, messages } = setup({ stream: s.stream, nudges: true });
    expect(await runLoop(input)).toMatchObject({ stop: "done", steps: 2 });
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: UNBACKED_PASS_NOTE }] });
    expect(events.filter((e) => e.kind === "notice" && e.text.startsWith("Nudged:"))).toHaveLength(1);
    // The second answer claims a pass too, but the nudge has already fired.
    expect(messages.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("does not nudge an answer whose bash call ran a check", async () => {
    const s = script([call("c1", "bash", { command: "npm test" })], text("All tests pass."));
    const { input, events, messages } = setup({ stream: s.stream, tools: [tool("bash", "shell")], nudges: true });
    expect(await runLoop(input)).toMatchObject({ stop: "done", steps: 2 });
    expect(s.requests).toHaveLength(2);
    expect(events.some((e) => e.kind === "notice" && e.text.startsWith("Nudged:"))).toBe(false);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("appends the repeat-fail note to the third failing result only", async () => {
    const { input, messages } = setup({ stream: repeatFail().stream, tools: repeatFailTools(), nudges: true });
    expect(await runLoop(input)).toMatchObject({ stop: "done", steps: 6 });
    expect(bashTexts(messages)).toEqual(["boom", "boom", `boom\n\n${REPEAT_FAIL_NOTE}`]);
  });

  it("leaves the third failing result unchanged without the flag", async () => {
    const { input, messages } = setup({ stream: repeatFail().stream, tools: repeatFailTools() });
    expect(await runLoop(input)).toMatchObject({ stop: "done", steps: 6 });
    expect(bashTexts(messages)).toEqual(["boom", "boom", "boom"]);
  });
});

describe("runsInParallel", () => {
  it("defaults to the legacy read rule and lets explicit flags win", () => {
    expect(runsInParallel(undefined)).toBe(false);
    expect(runsInParallel(tool("read", "read"))).toBe(true);
    expect(runsInParallel(tool("edit", "edit"))).toBe(false);
    expect(runsInParallel(tool("read", "read", undefined, false))).toBe(false);
    expect(runsInParallel(tool("edit", "edit", undefined, true))).toBe(true);
  });
});

describe("decide", () => {
  it("maps mode × access", () => {
    expect(["ask", "auto-edit", "plan", "full"].map((m) => decide(m as never, "read"))).toEqual(["allow", "allow", "allow", "allow"]);
    expect(["ask", "auto-edit", "plan", "full"].map((m) => decide(m as never, "edit"))).toEqual(["ask", "allow", "deny", "allow"]);
    expect(["ask", "auto-edit", "plan", "full"].map((m) => decide(m as never, "shell"))).toEqual(["ask", "ask", "deny", "allow"]);
    expect(decide("auto-edit", "edit", true)).toBe("ask");
    // Reads outside the folder never ask: members read their own skill files there.
    expect(["ask", "auto-edit", "plan", "full"].map((m) => decide(m as never, "read", true))).toEqual(["allow", "allow", "allow", "allow"]);
    // A fetch reads, but a URL can carry data out: it asks unless the mode is full, plan mode included.
    expect(["ask", "auto-edit", "plan", "full"].map((m) => decide(m as never, "web"))).toEqual(["ask", "ask", "ask", "allow"]);
  });
});

describe("refusal", () => {
  it("tells the model not to work around a user's denial", () => {
    const text = refusal("ask", "denied-by-user");
    expect(text).toMatch(/don't retry/i);
    expect(text).toMatch(/don't get the same result another way/i);
    expect(text).not.toMatch(/another approach/i);
  });

  it("keeps the mode refusals", () => {
    expect(refusal("plan", "deny")).toMatch(/^Plan mode is read-only/);
    expect(refusal("ask", "deny")).toBe("This call isn't allowed in the current mode.");
  });
});
