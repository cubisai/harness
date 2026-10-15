// The agent loop: call the model, show what it says, run the tools it asks for,
// feed the results back, repeat until it answers without tools. Read-only calls
// in a row run together; edits and commands run one at a time, in order.
// History stays valid on every exit: each tool call gets a result.

import type { ThreadEvent } from "../../shared/types";
import { claimsPass, ranChecks } from "../evidence";
import { streamLlm, type Route } from "./llm/client";
import type { AssistantPart, LlmMessage, LlmRequest, LlmUsage, ToolCallPart, ToolDefinition, ToolResult as LlmToolResult } from "./llm/types";
import { LlmError, emptyUsage } from "./llm/types";
import { ToolError, type ToolAccess, type ToolResult } from "./tools/types";

/** A tool as the loop sees it: the harness's own, or an app tool adapted. */
export interface LoopTool {
  definition: ToolDefinition;
  displayName: string;
  access: ToolAccess;
  summarize(args: Record<string, unknown>): string;
  /** The tool-use payload the thread shows; the arguments when absent. */
  inputPayload?(args: Record<string, unknown>): unknown;
  /** True when the call reaches outside the thread's folder (edits there ask). */
  outside?(args: Record<string, unknown>): boolean;
  run(args: Record<string, unknown>, call: { id: string; signal: AbortSignal; onOutput(text: string): void }): Promise<ToolResult>;
}

export interface LoopEmitter {
  event(e: ThreadEvent): void;
  textDelta(text: string, itemId: string): void;
  reasoningDelta(itemId: string, text: string): void;
  toolInputDelta(toolUseId: string, text: string): void;
  toolOutputDelta(toolUseId: string, text: string): void;
  usage(u: LlmUsage): void;
}

export type Authorization = { ok: true } | { ok: false; reason: string };

export interface LoopInput {
  route: Route;
  request: Omit<LlmRequest, "messages" | "tools">;
  /** The history, the new user message last; the loop appends to it. */
  messages: LlmMessage[];
  tools: LoopTool[];
  signal: AbortSignal;
  /** An id for this turn's live items. */
  turnId: string;
  maxSteps?: number;
  /** Self-improve S6: opt in to in-turn nudges (a repeated failing command, an unbacked "tests pass"). */
  nudges?: boolean;
  /** Decide (and ask the user when the mode says so) before a call runs. */
  authorize(tool: LoopTool, args: Record<string, unknown>, summary: string): Promise<Authorization>;
  emit: LoopEmitter;
  /** Every message the loop appends, for the session store. */
  onMessage(m: LlmMessage): void;
  /** Runs before every model call, after the abort check; it may rewrite `messages` in place. */
  prepare?(messages: LlmMessage[], last: LlmUsage | null): Promise<void>;
  /** On an overflow before anything streamed; true retries the step once (a second overflow rethrows). */
  onOverflow?(messages: LlmMessage[]): Promise<boolean>;
  /** Tests. */
  stream?: typeof streamLlm;
}

export type LoopStop = "done" | "max-steps" | "stopped" | "length" | "refusal";

export interface LoopResult {
  stop: LoopStop;
  /** Summed over every call of the turn. */
  usage: LlmUsage;
  /** The last call's usage: what the context holds now. */
  last: LlmUsage | null;
  steps: number;
}

export const DEFAULT_MAX_STEPS = 100;
const DOOM_REPEATS = 3;
/** Self-improve S6: failures of the same call (any order) that earn the note. */
const REPEAT_FAIL_AT = 3;
const READ_CONCURRENCY = 8;

/** Self-improve S6: appended to the third failing result of one call in a turn, when nudges are on. */
export const REPEAT_FAIL_NOTE = "This exact command has now failed 3 times this turn. Don't run it again unchanged: read the error, change the approach, or tell the user what's blocking you.";
/** Self-improve S6: a user message after an answer claims checks pass without one running, when nudges are on. */
export const UNBACKED_PASS_NOTE = "You said tests or checks pass, but no test, typecheck, lint or build command ran this turn. Run the relevant check now and report its real result, or say plainly that it wasn't run.";

const add = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens === null && b.cacheReadTokens === null ? null : (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  cacheWriteTokens: a.cacheWriteTokens === null && b.cacheWriteTokens === null ? null : (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  reasoningTokens: a.reasoningTokens === null && b.reasoningTokens === null ? null : (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
});

const oneLine = (text: string, max = 160): string => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const stream = input.stream ?? streamLlm;
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const byName = new Map(input.tools.map((t) => [t.definition.name, t]));
  const definitions = input.tools.map((t) => t.definition);
  const recent: string[] = [];
  // Self-improve S6: per-turn state for the opt-in nudges — failure counts, and
  // one flag per note so each fires at most once in the whole turn.
  const fails = new Map<string, number>();
  const nudge = { repeat: false };
  const bashCommands: string[] = [];
  let passNudged = false;
  let usage = emptyUsage();
  let last: LlmUsage | null = null;
  let overflowRetried = false;

  const append = (m: LlmMessage): void => {
    input.messages.push(m);
    input.onMessage(m);
  };

  for (let step = 0; step < maxSteps; step++) {
    if (input.signal.aborted) return { stop: "stopped", usage, last, steps: step };
    if (input.prepare) {
      try {
        await input.prepare(input.messages, last);
      } catch (err) {
        // A stop that lands mid-prepare (compaction streaming) ends the turn
        // cleanly instead of surfacing as an error.
        if ((err instanceof LlmError && err.kind === "aborted") || input.signal.aborted) return { stop: "stopped", usage, last, steps: step };
        throw err;
      }
    }
    const itemId = `${input.turnId}-${step}`;
    let liveText = "";
    let message: AssistantPart[] | null = null;
    let reason: string = "stop";
    let streamedText = false;
    let streamedToolInput = false;

    try {
      for await (const e of stream(input.route, { ...input.request, messages: input.messages, tools: definitions }, { signal: input.signal })) {
        if (e.type === "text-delta") {
          streamedText = true;
          liveText += e.text;
          input.emit.textDelta(e.text, `${itemId}-t`);
        } else if (e.type === "reasoning-delta") input.emit.reasoningDelta(`${itemId}-r`, e.text);
        else if (e.type === "tool-input-delta") {
          streamedToolInput = true;
          input.emit.toolInputDelta(e.id, e.delta);
        } else if (e.type === "usage") input.emit.usage(add(usage, e.usage));
        else {
          message = e.message;
          reason = e.reason;
          usage = add(usage, e.usage);
          last = e.usage;
        }
      }
    } catch (err) {
      if (err instanceof LlmError && err.kind === "aborted") {
        // Keep what was already said, so the conversation reads on from it.
        if (liveText.trim()) {
          input.emit.event({ kind: "assistant-text", text: liveText, itemId: `${itemId}-t` });
          append({ role: "assistant", content: [{ type: "text", text: liveText }] });
        }
        return { stop: "stopped", usage, last, steps: step + 1 };
      }
      // An overflow with nothing streamed yet can be retried once, by compacting first.
      if (err instanceof LlmError && err.kind === "overflow" && !streamedText && !streamedToolInput && input.onOverflow && !overflowRetried) {
        overflowRetried = true;
        if (await input.onOverflow(input.messages)) {
          step--; // The retry isn't a step.
          continue;
        }
      }
      throw err;
    }
    if (!message) throw new LlmError(`${input.route.label} ended the answer early.`, "transient");

    showMessage(input.emit, message, itemId);
    append({ role: "assistant", content: message });
    const calls = message.filter((p): p is ToolCallPart => p.type === "tool-call");
    if (calls.length === 0) {
      if (reason === "length") {
        input.emit.event({ kind: "notice", text: "The answer stopped at the model's output limit." });
        return { stop: "length", usage, last, steps: step + 1 };
      }
      // Self-improve S6: an answer claiming checks pass with none run gets one
      // corrective user message, so the next step runs a real check.
      const answer = message.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      if (input.nudges === true && !passNudged && step + 1 < maxSteps && claimsPass(answer) && !ranChecks(bashCommands)) {
        passNudged = true;
        append({ role: "user", content: [{ type: "text", text: UNBACKED_PASS_NOTE }] });
        input.emit.event({ kind: "notice", text: "Nudged: the answer said checks pass, but none ran this turn." });
        continue;
      }
      return { stop: reason === "refusal" ? "refusal" : "done", usage, last, steps: step + 1 };
    }

    for (const c of calls) {
      if (byName.get(c.name)?.definition.name === "bash" && typeof c.input.command === "string") bashCommands.push(c.input.command);
    }
    const results = await runCalls(input, calls, byName, recent, fails, nudge);
    append({ role: "tool", results });
    if (input.signal.aborted) return { stop: "stopped", usage, last, steps: step + 1 };
  }
  input.emit.event({ kind: "notice", text: `Stopped after ${maxSteps} steps. Send a message to let it continue.` });
  return { stop: "max-steps", usage, last, steps: maxSteps };
}

/** The finished message as thread events: thinking, the text (clearing its live item), each call. */
function showMessage(emit: LoopEmitter, message: AssistantPart[], itemId: string): void {
  const thought = message.flatMap((p) => (p.type === "reasoning" && p.text ? [p.text] : [])).join("\n\n");
  if (thought) emit.event({ kind: "thinking", text: thought, itemId: `${itemId}-r` });
  const text = message.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
  if (text.trim()) emit.event({ kind: "assistant-text", text, itemId: `${itemId}-t` });
}

type Planned = { call: ToolCallPart; tool: LoopTool | undefined };

async function runCalls(input: LoopInput, calls: ToolCallPart[], byName: Map<string, LoopTool>, recent: string[], fails: Map<string, number>, nudge: { repeat: boolean }): Promise<LlmToolResult[]> {
  const planned: Planned[] = calls.map((call) => ({ call, tool: byName.get(call.name) }));
  for (const { call, tool } of planned) {
    const summary = tool ? safeSummary(tool, call.input) : call.name;
    input.emit.event({ kind: "tool-use", toolUseId: call.id, name: tool?.displayName ?? call.name, summary, payload: tool?.inputPayload ? tool.inputPayload(call.input) : call.input });
  }

  const results: LlmToolResult[] = new Array(planned.length);
  let i = 0;
  while (i < planned.length) {
    if (input.signal.aborted) {
      for (; i < planned.length; i++) results[i] = finish(input, planned[i]!, { text: "Interrupted by the user.", isError: true }, fails, nudge);
      break;
    }
    // A run of read-only calls goes together; anything else runs alone.
    let j = i + 1;
    if (planned[i]!.tool?.access === "read") while (j < planned.length && j - i < READ_CONCURRENCY && planned[j]!.tool?.access === "read") j++;
    const batch = planned.slice(i, j);
    const done = await Promise.all(batch.map((p) => runOne(input, p, recent)));
    done.forEach((r, k) => (results[i + k] = finish(input, batch[k]!, r, fails, nudge)));
    i = j;
  }
  return results;
}

function safeSummary(tool: LoopTool, args: Record<string, unknown>): string {
  try {
    return oneLine(tool.summarize(args));
  } catch {
    return tool.displayName;
  }
}

async function runOne(input: LoopInput, { call, tool }: Planned, recent: string[]): Promise<ToolResult> {
  if (!tool) return { text: `There's no tool named "${call.name}". Use one of: ${[...input.tools.map((t) => t.definition.name)].join(", ")}.`, isError: true };
  if (call.invalidInput !== undefined) return { text: `The arguments weren't valid JSON: ${call.invalidInput.slice(0, 200)}. Send them again as a JSON object.`, isError: true };

  const signature = `${call.name}:${JSON.stringify(call.input)}`;
  recent.push(signature);
  if (recent.length > DOOM_REPEATS) recent.shift();
  if (recent.length === DOOM_REPEATS && recent.every((s) => s === signature)) {
    return { text: `You've made this exact call ${DOOM_REPEATS} times in a row. Stop repeating it: change the approach, or tell the user what's blocking you.`, isError: true };
  }

  const auth = await input.authorize(tool, call.input, safeSummary(tool, call.input));
  if (!auth.ok) return { text: auth.reason, isError: true };
  if (input.signal.aborted) return { text: "Interrupted by the user.", isError: true };
  try {
    return await tool.run(call.input, { id: call.id, signal: input.signal, onOutput: (text) => input.emit.toolOutputDelta(call.id, text) });
  } catch (err) {
    if (err instanceof ToolError) return { text: err.message, isError: true };
    return { text: `${tool.displayName} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

function finish(input: LoopInput, { call, tool }: Planned, r: ToolResult, fails: Map<string, number>, nudge: { repeat: boolean }): LlmToolResult {
  input.emit.event({ kind: "tool-result", toolUseId: call.id, isError: r.isError === true, summary: oneLine(r.text), payload: r.display?.result ?? r.text });
  let text = r.text;
  if (r.isError === true) {
    const key = `${call.name}:${JSON.stringify(call.input)}`;
    const failed = (fails.get(key) ?? 0) + 1;
    fails.set(key, failed);
    // Self-improve S6: the same call failing REPEAT_FAIL_AT times (any order) gets
    // one corrective note in the result the model reads, once per turn.
    if (input.nudges === true && failed >= REPEAT_FAIL_AT && !nudge.repeat) {
      nudge.repeat = true;
      text = `${text}\n\n${REPEAT_FAIL_NOTE}`;
    }
  }
  return { callId: call.id, name: tool?.definition.name ?? call.name, text, ...(r.isError ? { isError: true } : {}), ...(r.imagePng ? { imagePng: r.imagePng } : {}) };
}
