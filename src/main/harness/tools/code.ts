// P3.5 pilot: a flagged `run_code` tool that runs a JavaScript program in a
// QuickJS sandbox. The program calls the agent's other tools through a broker,
// so dependent calls chain and large results are reduced before the model sees
// them.

import { getQuickJS, isFail, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten";
import { bm25Rank } from "../../search/bm25";
import type { LoopTool } from "../loop";
import { bound } from "./bound";
import { toTsDeclaration } from "./ts-decl";

/** Tools a script may never call: no nested agents, plans or questions from code. */
const EXCLUDED = new Set(["run_code", "task", "propose_plan", "ask_user"]);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024;

/** Limits on what a script may keep in the session state, in characters. */
const MAX_STATE_VALUE_CHARS = 256 * 1024;
const MAX_STATE_CHARS = 1024 * 1024;

export interface CodeToolOptions {
  /** Every tool the loop offers; `run_code` and the agent-ish ones are hidden from a script. */
  tools: () => LoopTool[];
  /** Run one tool call for the sandbox; the driver authorizes and traces it. */
  /** `data`, when set, is what the script's `await` gets (read/glob/grep values); otherwise the text. */
  broker: (name: string, args: Record<string, unknown>, parentId: string, signal: AbortSignal) => Promise<{ text: string; isError: boolean; data?: unknown }>;
  outputDir: string;
  timeoutMs?: number;
  memoryBytes?: number;
  /** Values kept across scripts in one session, as JSON text; a script's writes commit only when it succeeds. */
  state?: Map<string, string>;
}

/** A tool's one required string parameter, which a bare string argument fills; undefined when it has none or several. */
function mainArg(tool: LoopTool): string | undefined {
  const { required, properties } = tool.definition.parameters as { required?: unknown; properties?: Record<string, { type?: unknown }> };
  if (!Array.isArray(required) || required.length !== 1 || typeof required[0] !== "string") return undefined;
  return properties?.[required[0]]?.type === "string" ? required[0] : undefined;
}

export const CODE_DESCRIPTION = [
  // The trigger leads: models pick tools by description, and without it they reach for one read or shell call after another.
  "Use this to look around the project instead of two or more read, glob, grep, ls or cat calls: one script lists, reads and searches it all in one step.",
  "Run a JavaScript program in a sandbox and return what it prints and returns.",
  "The code is the body of an async function: call tools as `await tools.<name>(args)`, which throws on an error (wrap a call that may fail in try/catch).",
  'read, glob and grep return plain values, not text: glob gives string[] paths (empty when nothing matches); grep gives string[] files, or { path: count } with output_mode "count", or [{ path, line, text }] with "content"; read gives the file\'s text. Other tools return their text output.',
  "`ALL_TOOLS` lists the tools, `searchTools(query)` ranks them, and `describeTool(name)` returns a TypeScript declaration.",
  "Batch: one broad call (a grep pattern like `a|b|c`, then filtering in JavaScript) beats a call per item, and Promise.all runs calls together.",
  "`store(key, value)` and `load(key)` keep JSON between scripts in this session, and a failed script's writes are dropped.",
  "`console.log(...)` lines plus the returned value (JSON-stringified unless it's a string) are the result: return only what you need.",
  "The sandbox has no filesystem, network, process, timers or modules (no require or import: reach files only through `tools`), and calls made before an error are not undone.",
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
      description: CODE_DESCRIPTION,
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
      // Host promises of tool calls still in flight: freed before the context, or QuickJS aborts on a leak.
      const pending = new Set<QuickJSDeferredPromise>();
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
        // Writes go to a copy; only a successful run commits them to the session.
        const staged = new Map<string, string>(o.state);
        install(context, live, o, logs, call.id, call.signal, staged, pending);

        const evaluated = context.evalCode(`(async () => {\n${code}\n})()`);
        if (isFail(evaluated)) {
          const message = explain(errorText(context, evaluated.error), o);
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
          const message = explain(errorText(context, settled.error), o);
          settled.error.dispose();
          return { text: failure(stopReason === "abort" ? STOPPED : stopReason === "timeout" ? timingOut(timeoutMs) : message, logs), isError: true };
        }
        const rendered = render(context, settled.value);
        settled.value.dispose();
        if (o.state) {
          o.state.clear();
          for (const [key, value] of staged) o.state.set(key, value);
        }
        const text = [...logs, `=> ${rendered}`].join("\n");
        return { text: bound(text, { outputDir: o.outputDir, callId: call.id }) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { text: failure(stopReason === "abort" ? STOPPED : stopReason === "timeout" ? timingOut(timeoutMs) : message, logs), isError: true };
      } finally {
        for (const deferred of pending) if (deferred.alive) deferred.dispose();
        pending.clear();
        context?.dispose();
        runtime?.dispose();
      }
    },
  };
}

const STOPPED = "Interrupted by the user.";
const timingOut = (timeoutMs: number): string => `Stopped after ${Math.round(timeoutMs / 1000)}s: the time limit was reached.`;

/** The globals a script sees: `tools`, `ALL_TOOLS`, `searchTools`, `describeTool`, `store`, `load` and `console.log`. */
function install(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  o: CodeToolOptions,
  logs: string[],
  parentId: string,
  signal: AbortSignal,
  staged: Map<string, string>,
  pending: Set<QuickJSDeferredPromise>,
): void {
  const console_ = context.newObject();
  const log = context.newFunction("log", (...handles) => {
    logs.push(handles.map((h) => format(context.dump(h))).join(" "));
  });
  context.setProp(console_, "log", log);
  log.dispose();
  context.setProp(context.global, "console", console_);
  console_.dispose();

  const exposed = (): LoopTool[] => o.tools().filter((t) => !EXCLUDED.has(t.definition.name));

  const all = context.newArray();
  exposed().forEach((tool, i) => {
    const handle = toHandle(context, { name: tool.definition.name, description: firstSentence(tool.definition.description) });
    context.setProp(all, i, handle);
    handle.dispose();
  });
  context.setProp(context.global, "ALL_TOOLS", all);
  all.dispose();

  const search = context.newFunction("searchTools", (queryHandle, limitHandle) => {
    const query = queryHandle ? context.getString(queryHandle) : "";
    const wanted = limitHandle ? context.dump(limitHandle) : undefined;
    const limit = typeof wanted === "number" && wanted > 0 ? Math.floor(wanted) : 8;
    const tools = exposed();
    const ranked = bm25Rank(tools, (t) => `${t.definition.name} ${t.definition.description}`, query, limit).map(({ item }) => item);
    // No BM25 hit (a short, partial word, say): keep the old substring filter.
    const hits = ranked.length
      ? ranked
      : tools.filter((t) => t.definition.name.toLowerCase().includes(query.toLowerCase()) || t.definition.description.toLowerCase().includes(query.toLowerCase())).slice(0, limit);
    return toHandle(
      context,
      hits.map((t) => ({ name: t.definition.name, description: t.definition.description })),
    );
  });
  context.setProp(context.global, "searchTools", search);
  search.dispose();

  const describe = context.newFunction("describeTool", (nameHandle) => {
    const name = nameHandle ? context.getString(nameHandle) : "";
    const tool = exposed().find((t) => t.definition.name === name);
    return tool ? context.newString(toTsDeclaration(tool.definition.name, tool.definition.description, tool.definition.parameters, tool.returns)) : context.null;
  });
  context.setProp(context.global, "describeTool", describe);
  describe.dispose();

  const fail = (message: string): { error: QuickJSHandle } => ({ error: context.newError(message) });
  const store = context.newFunction("store", (keyHandle, valueHandle) => {
    if (!keyHandle || context.typeof(keyHandle) !== "string" || !context.getString(keyHandle)) return fail("store(key, value): key must be a non-empty string.");
    const key = context.getString(keyHandle);
    let text: string | undefined;
    try {
      text = JSON.stringify(valueHandle ? context.dump(valueHandle) : undefined);
    } catch {
      text = undefined;
    }
    if (text === undefined) return fail("store(key, value): the value is not JSON-serialisable.");
    if (text.length > MAX_STATE_VALUE_CHARS) return fail(`store(key, value): one value may not exceed ${MAX_STATE_VALUE_CHARS} characters.`);
    let total = key.length + text.length;
    for (const [k, v] of staged) if (k !== key) total += k.length + v.length;
    if (total > MAX_STATE_CHARS) return fail(`store(key, value): the session state may not exceed ${MAX_STATE_CHARS} characters.`);
    staged.set(key, text);
  });
  context.setProp(context.global, "store", store);
  store.dispose();

  const load = context.newFunction("load", (keyHandle) => {
    const key = keyHandle ? context.getString(keyHandle) : "";
    const text = staged.get(key);
    if (text === undefined) return context.undefined;
    try {
      return toHandle(context, JSON.parse(text));
    } catch {
      return context.undefined;
    }
  });
  context.setProp(context.global, "load", load);
  load.dispose();

  const tools = context.newObject();
  for (const tool of o.tools()) {
    if (EXCLUDED.has(tool.definition.name)) continue;
    const fn = context.newFunction(tool.definition.name, (...handles) => {
      const deferred = context.newPromise();
      pending.add(deferred);
      const first = handles[0];
      let callArgs: Record<string, unknown> = {};
      if (first) {
        try {
          const dumped = context.dump(first);
          if (dumped && typeof dumped === "object" && !Array.isArray(dumped)) callArgs = dumped as Record<string, unknown>;
          // A bare string is the tool's one required text argument: tools.read("a.ts"), tools.glob("**/*.md").
          else if (typeof dumped === "string" && mainArg(tool)) callArgs = { [mainArg(tool)!]: dumped };
        } catch {
          // Anything else reaches the tool as {}; its own validation reports the shape.
        }
      }
      const settle = (r: { text: string; isError: boolean; data?: unknown }): void => {
        pending.delete(deferred);
        if (!deferred.alive || !context.alive) return;
        if (r.isError) {
          const error = context.newError(r.text);
          deferred.reject(error);
          error.dispose();
        } else {
          const value = r.data !== undefined ? toHandle(context, r.data) : context.newString(r.text);
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

/** The first sentence of a tool description, cut to `max` characters. */
function firstSentence(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  const sentence = line.split(/(?<=[.!?])\s+/)[0] ?? "";
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

function json(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** QuickJS says only "not a function" for tools.shell(); name the tools a script has, since models try tools.bash, tools.ls and tools.cat. */
function explain(message: string, o: CodeToolOptions): string {
  if (!/not a function/.test(message)) return message;
  const names = o.tools().map((t) => t.definition.name).filter((n) => !EXCLUDED.has(n));
  return `${message}. A script's tools are: ${names.join(", ")}. Read files with tools.read (a folder lists), search with tools.grep and tools.glob; edits and shell commands are not available in a script.`;
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
