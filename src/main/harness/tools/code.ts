// P3.5 pilot: a flagged `run_code` tool that runs a JavaScript program in a
// QuickJS sandbox. The program calls the agent's other tools through a broker,
// so dependent calls chain and large results are reduced before the model sees
// them.

import { getQuickJS, isFail, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten";
import type { LoopTool } from "../loop";
import { bound } from "./bound";

/** Tools a script may never call: no nested agents, plans or questions from code. */
const EXCLUDED = new Set(["run_code", "task", "propose_plan", "ask_user"]);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024;

export interface CodeToolOptions {
  /** Every tool the loop offers; `run_code` and the agent-ish ones are hidden from a script. */
  tools: () => LoopTool[];
  /** Run one tool call for the sandbox; the driver authorizes and traces it. */
  broker: (name: string, args: Record<string, unknown>, parentId: string, signal: AbortSignal) => Promise<{ text: string; isError: boolean }>;
  outputDir: string;
  timeoutMs?: number;
  memoryBytes?: number;
}

const DESCRIPTION = [
  "Run a JavaScript program in a sandbox and return what it prints and returns.",
  "The code is the body of an async function. Call the other tools as `await tools.<name>(args)`, which returns the tool's text output; a tool error throws an Error. `searchTools(query)` lists the tools whose name or description matches, and `describeTool(name)` gives one tool's JSON parameters.",
  "`console.log(...)` lines plus the returned value (JSON-stringified unless it's a string) are the result.",
  "The sandbox has no filesystem, network, process or timers. Calls made before an error are not undone.",
].join(" ");

let modulePromise: Promise<QuickJSWASMModule> | null = null;
/** The shared QuickJS module, loaded once. */
const quickJS = (): Promise<QuickJSWASMModule> => (modulePromise ??= getQuickJS());

export function createCodeTool(o: CodeToolOptions): LoopTool {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryBytes = o.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  return {
    definition: {
      name: "run_code",
      description: DESCRIPTION,
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "The JavaScript to run, as the body of an async function." } },
        required: ["code"],
      },
    },
    displayName: "run_code",
    // The script is one edit-like call: ask mode asks once for it, and the broker
    // authorizes every tool call the script then makes.
    access: "edit",
    parallel: false,
    summarize: (args) => oneLine(String(args.code ?? "")),
    run: async (args, call) => {
      const code = typeof args.code === "string" ? args.code : "";
      const logs: string[] = [];
      let stopReason: "timeout" | "abort" | null = null;
      let runtime: QuickJSRuntime | null = null;
      let context: QuickJSContext | null = null;
      let stop: { promise: Promise<void>; done: () => void } | null = null;
      try {
        const QuickJS = await quickJS();
        runtime = QuickJS.newRuntime();
        const live = runtime;
        live.setMemoryLimit(memoryBytes);
        // Stops a runaway loop or a script left waiting on a host function.
        const afterDeadline = shouldInterruptAfterDeadline(Date.now() + timeoutMs);
        live.setInterruptHandler(() => {
          if (call.signal.aborted) {
            stopReason = "abort";
            return true;
          }
          if (afterDeadline(live)) {
            stopReason = "timeout";
            return true;
          }
          return false;
        });
        context = live.newContext();
        install(context, live, o, logs, call.id, call.signal);

        const evaluated = context.evalCode(`(async () => {\n${code}\n})()`);
        if (isFail(evaluated)) {
          const message = errorText(context, evaluated.error);
          evaluated.error.dispose();
          return { text: failure(stopReason === "abort" ? STOPPED : stopReason === "timeout" ? timingOut(timeoutMs) : message, logs), isError: true };
        }
        const promise = evaluated.value;
        stop = watchStop(call.signal, timeoutMs, (r) => (stopReason = r));
        let settled: Awaited<ReturnType<QuickJSContext["resolvePromise"]>> | null = null;
        try {
          // resolvePromise registers a host callback on the script's promise; the
          // jobs that run it (and any the script left pending) have to be driven.
          const settledPromise = context.resolvePromise(promise);
          const kick = live.executePendingJobs();
          if (isFail(kick)) kick.error.dispose();
          settled = await Promise.race([settledPromise, stop.promise.then(() => null)]);
        } finally {
          stop.done();
          promise.dispose();
        }
        if (settled === null) {
          return { text: failure(stopReason === "abort" ? STOPPED : timingOut(timeoutMs), logs), isError: true };
        }
        if (isFail(settled)) {
          const message = errorText(context, settled.error);
          settled.error.dispose();
          return { text: failure(stopReason === "abort" ? STOPPED : stopReason === "timeout" ? timingOut(timeoutMs) : message, logs), isError: true };
        }
        const rendered = render(context, settled.value);
        settled.value.dispose();
        const text = [...logs, `=> ${rendered}`].join("\n");
        return { text: bound(text, { outputDir: o.outputDir, callId: call.id }) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { text: failure(stopReason === "abort" ? STOPPED : stopReason === "timeout" ? timingOut(timeoutMs) : message, logs), isError: true };
      } finally {
        context?.dispose();
        runtime?.dispose();
      }
    },
  };
}

const STOPPED = "Interrupted by the user.";
const timingOut = (timeoutMs: number): string => `Stopped after ${Math.round(timeoutMs / 1000)}s: the time limit was reached.`;

/** The globals a script sees: `tools`, `searchTools`, `describeTool` and `console.log`. */
function install(context: QuickJSContext, runtime: QuickJSRuntime, o: CodeToolOptions, logs: string[], parentId: string, signal: AbortSignal): void {
  const console_ = context.newObject();
  const log = context.newFunction("log", (...handles) => {
    logs.push(handles.map((h) => format(context.dump(h))).join(" "));
  });
  context.setProp(console_, "log", log);
  log.dispose();
  context.setProp(context.global, "console", console_);
  console_.dispose();

  const search = context.newFunction("searchTools", (queryHandle) => {
    const query = queryHandle ? context.getString(queryHandle).toLowerCase() : "";
    const hits = o
      .tools()
      .filter((t) => !EXCLUDED.has(t.definition.name) && (t.definition.name.toLowerCase().includes(query) || t.definition.description.toLowerCase().includes(query)))
      .slice(0, 25)
      .map((t) => ({ name: t.definition.name, description: t.definition.description }));
    return toHandle(context, hits);
  });
  context.setProp(context.global, "searchTools", search);
  search.dispose();

  const describe = context.newFunction("describeTool", (nameHandle) => {
    const name = nameHandle ? context.getString(nameHandle) : "";
    const tool = o.tools().find((t) => t.definition.name === name && !EXCLUDED.has(t.definition.name));
    return tool ? toHandle(context, tool.definition.parameters) : context.null;
  });
  context.setProp(context.global, "describeTool", describe);
  describe.dispose();

  const tools = context.newObject();
  for (const tool of o.tools()) {
    if (EXCLUDED.has(tool.definition.name)) continue;
    const fn = context.newFunction(tool.definition.name, (...handles) => {
      const deferred = context.newPromise();
      const first = handles[0];
      let callArgs: Record<string, unknown> = {};
      if (first) {
        try {
          const dumped = context.dump(first);
          if (dumped && typeof dumped === "object" && !Array.isArray(dumped)) callArgs = dumped as Record<string, unknown>;
        } catch {
          // Non-object arguments reach the tool as {}; its own validation reports the shape.
        }
      }
      const settle = (r: { text: string; isError: boolean }): void => {
        if (!deferred.alive) return;
        if (r.isError) {
          const error = context.newError(r.text);
          deferred.reject(error);
          error.dispose();
        } else {
          const value = context.newString(r.text);
          deferred.resolve(value);
          value.dispose();
        }
      };
      o.broker(tool.definition.name, callArgs, parentId, signal).then(settle, (err) => settle({ text: err instanceof Error ? err.message : String(err), isError: true }));
      // A settled host promise resumes whatever in the script awaited it.
      deferred.settled.then(() => {
        if (runtime.alive) runtime.executePendingJobs();
      });
      return deferred.handle;
    });
    context.setProp(tools, tool.definition.name, fn);
    fn.dispose();
  }
  context.setProp(context.global, "tools", tools);
  tools.dispose();
}

/** Build a QuickJS value from a plain JSON one. */
function toHandle(context: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === null) return context.null;
  if (typeof value === "string") return context.newString(value);
  if (typeof value === "number") return context.newNumber(value);
  if (typeof value === "boolean") return value ? context.true : context.false;
  if (Array.isArray(value)) {
    const array = context.newArray();
    value.forEach((item, i) => {
      const handle = toHandle(context, item);
      context.setProp(array, i, handle);
      handle.dispose();
    });
    return array;
  }
  const object = context.newObject();
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const handle = toHandle(context, item);
    context.setProp(object, key, handle);
    handle.dispose();
  }
  return object;
}

/** A thrown QuickJS value as text: an Error's message when it has one. */
function errorText(context: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = context.dump(handle);
  if (dumped && typeof dumped === "object" && "message" in dumped) return String((dumped as { message: unknown }).message);
  return format(dumped);
}

/** The returned value: a string as itself, anything else as JSON. */
const render = (context: QuickJSContext, handle: QuickJSHandle): string => format(context.dump(handle));

const format = (value: unknown): string => (typeof value === "string" ? value : json(value));

function json(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** Console output before an error still reaches the model, with the error after it. */
function failure(message: string, logs: string[]): string {
  const tail = `Error: ${message}\n\nCalls made before the error are not undone.`;
  return logs.length ? `${logs.join("\n")}\n\n${tail}` : tail;
}

/** Stops a script that is waiting on a host function no interrupt can reach. */
function watchStop(signal: AbortSignal, timeoutMs: number, onStop: (reason: "timeout" | "abort") => void): { promise: Promise<void>; done: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  const onAbort = (): void => {
    onStop("abort");
    resolve();
  };
  const timer = setTimeout(() => {
    onStop("timeout");
    resolve();
  }, timeoutMs);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    done: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

const oneLine = (text: string, max = 160): string => {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "run_code";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
