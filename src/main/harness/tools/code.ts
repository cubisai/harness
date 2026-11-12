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
  "The code is the body of an async function: call tools as `await tools.<name>(args)`, which throws on an error (wrap a call that may fail in try/catch, or use `await tools.readMany(paths, opts?)` for `{ path, content?, entries?, error? }[]` across a batch).",
  'read, glob and grep return plain values, not text: glob gives string[] paths (empty when nothing matches, optional `limit`); grep gives string[] files, or { path: count } with output_mode "count", or [{ path, line, text, before?, after? }] with "content" (optional `limit` and `context`); read gives the file\'s text (or string[] entries for a folder). Other tools return their text output.',
  "`ALL_TOOLS` lists the tools, `searchTools(query)` ranks them, `describeTool(name)` returns a TypeScript declaration, and `path` has POSIX string helpers (`join`, `dirname`, `basename`, `extname`, `normalize`).",
  "Batch: one broad call (a grep pattern like `a|b|c`, then filtering in JavaScript) beats a call per item, and Promise.all runs calls together.",
  "`store(key, value)` and `load(key)` keep JSON between scripts in this session, and a failed script's writes are dropped.",
  "`console.log(...)` (and warn/error/info) lines plus the returned value (JSON-stringified unless it's a string) are the result: return only what you need.",
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
      let disposeInstall: (() => void) | null = null;
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
        disposeInstall = install(context, live, o, logs, call.id, call.signal, staged, pending);

        // "script.js" names the file in error stacks; the wrapper adds one line, so user line 1 is file line 2.
        const evaluated = context.evalCode(`(async () => {\n${code}\n})()`, "script.js");
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
        const wasUndefined = context.typeof(settled.value) === "undefined";
        const rendered = render(context, settled.value);
        settled.value.dispose();
        if (o.state) {
          o.state.clear();
          for (const [key, value] of staged) o.state.set(key, value);
        }
        let text = [...logs, `=> ${rendered}`].join("\n");
        if (wasUndefined && logs.length === 0) text += "\n\nThe script returned undefined and printed nothing: return a value (or console.log it) so there is something to read.";
        return { text: bound(text, { outputDir: o.outputDir, callId: call.id }) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { text: failure(stopReason === "abort" ? STOPPED : stopReason === "timeout" ? timingOut(timeoutMs) : message, logs), isError: true };
      } finally {
        for (const deferred of pending) if (deferred.alive) deferred.dispose();
        pending.clear();
        disposeInstall?.();
        context?.dispose();
        runtime?.dispose();
      }
    },
  };
}

const STOPPED = "Interrupted by the user.";
const timingOut = (timeoutMs: number): string => `Stopped after ${Math.round(timeoutMs / 1000)}s: the time limit was reached.`;

/** The globals a script sees: `tools` (plus `tools.readMany`), `ALL_TOOLS`, `searchTools`, `describeTool`, `store`, `load`, `path` and `console`. */
function install(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  o: CodeToolOptions,
  logs: string[],
  parentId: string,
  signal: AbortSignal,
  staged: Map<string, string>,
  pending: Set<QuickJSDeferredPromise>,
): () => void {
  // QuickJS's own JSON.parse, kept for the context's life: arrays and objects
  // cross the WASM boundary once, as text, instead of a handle per element or
  // property. The returned cleanup disposes it (the context doesn't).
  const json = context.getProp(context.global, "JSON");
  const jsonParse = context.getProp(json, "parse");
  json.dispose();
  const parseJson = (text: string): QuickJSHandle | null => {
    const arg = context.newString(text);
    try {
      const res = context.callFunction(jsonParse, context.undefined, arg);
      if (isFail(res)) {
        res.error.dispose();
        return null;
      }
      return res.value;
    } finally {
      arg.dispose();
    }
  };
  const toH = (value: unknown): QuickJSHandle => toHandle(context, value, parseJson);

  const console_ = context.newObject();
  for (const level of ["log", "info", "debug", "warn", "error"]) {
    const fn = context.newFunction(level, (...handles) => {
      logs.push(handles.map((h) => format(context.dump(h))).join(" "));
    });
    context.setProp(console_, level, fn);
    fn.dispose();
  }
  context.setProp(context.global, "console", console_);
  console_.dispose();

  const exposed = (): LoopTool[] => o.tools().filter((t) => !EXCLUDED.has(t.definition.name));

  const all = context.newArray();
  exposed().forEach((tool, i) => {
    const handle = toH({ name: tool.definition.name, description: firstSentence(tool.definition.description) });
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
    return toH(hits.map((t) => ({ name: t.definition.name, description: t.definition.description })));
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
    // The stored JSON text crosses once, parsed inside QuickJS.
    return parseJson(text) ?? context.undefined;
  });
  context.setProp(context.global, "load", load);
  load.dispose();

  /** A host promise for the script to await: `work` settles it with a plain value or an error message. */
  const defer = (work: () => Promise<{ value?: unknown; error?: string }>): QuickJSHandle => {
    const deferred = context.newPromise();
    pending.add(deferred);
    const settle = (r: { value?: unknown; error?: string }): void => {
      pending.delete(deferred);
      if (!deferred.alive || !context.alive) return;
      if (r.error !== undefined) {
        const error = context.newError(r.error);
        deferred.reject(error);
        error.dispose();
      } else {
        const value = r.value !== undefined ? toH(r.value) : context.newString("");
        deferred.resolve(value);
        value.dispose();
      }
    };
    work().then(settle, (err) => settle({ error: err instanceof Error ? err.message : String(err) }));
    // A settled host promise resumes whatever in the script awaited it.
    deferred.settled.then(() => {
      if (runtime.alive) runtime.executePendingJobs();
    });
    return deferred.handle;
  };

  const tools = context.newObject();
  for (const tool of o.tools()) {
    if (EXCLUDED.has(tool.definition.name)) continue;
    const fn = context.newFunction(tool.definition.name, (...handles) => {
      const first = handles[0];
      let callArgs: Record<string, unknown> = {};
      if (first) {
        try {
          const dumped = context.dump(first);
          if (dumped && typeof dumped === "object" && !Array.isArray(dumped)) callArgs = dumped as Record<string, unknown>;
          // A bare string is the tool's one required text argument: tools.read("a.ts"), tools.glob("**/*.md"), or tools.grep("pat", { output_mode: "content" }).
          else if (typeof dumped === "string" && mainArg(tool)) {
            const extra = handles[1] ? context.dump(handles[1]) : undefined;
            const rest = extra && typeof extra === "object" && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {};
            callArgs = { ...rest, [mainArg(tool)!]: dumped };
          }
        } catch {
          // Anything else reaches the tool as {}; its own validation reports the shape.
        }
      }
      return defer(async () => {
        const r = await o.broker(tool.definition.name, callArgs, parentId, signal);
        // Errors throw in the script (wrap a call that may fail in try/catch).
        if (r.isError) return { error: r.text };
        return r.data !== undefined ? { value: r.data } : { value: r.text };
      });
    });
    context.setProp(tools, tool.definition.name, fn);
    fn.dispose();
  }
  // tools.readMany(paths, opts?): read every path through the same broker (rows and read-tracking like one read
  // each), resolving to { path, content? | entries? | error? }[] — one missing or binary file doesn't fail the batch.
  const readMany = context.newFunction("readMany", (pathsHandle, optsHandle) => {
    let paths: unknown;
    try {
      paths = pathsHandle ? context.dump(pathsHandle) : undefined;
    } catch {
      paths = undefined;
    }
    let opts: Record<string, unknown> = {};
    try {
      const dumped = optsHandle ? context.dump(optsHandle) : undefined;
      if (dumped && typeof dumped === "object" && !Array.isArray(dumped)) opts = dumped as Record<string, unknown>;
    } catch {
      // Ignore a bad opts: read's own defaults apply.
    }
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) return fail("tools.readMany(paths, opts?): paths must be an array of strings.");
    const list = paths as string[];
    return defer(async () => {
      const results = await Promise.all(
        list.map(async (path) => {
          try {
            const r = await o.broker("read", { ...opts, path }, parentId, signal);
            if (r.isError) return { path, error: r.text };
            if (Array.isArray(r.data)) return { path, entries: r.data };
            return { path, content: typeof r.data === "string" ? r.data : r.text };
          } catch (err) {
            return { path, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      return { value: results };
    });
  });
  context.setProp(tools, "readMany", readMany);
  context.setProp(tools, "read_many", readMany);
  readMany.dispose();
  context.setProp(context.global, "tools", tools);
  tools.dispose();

  // Pure string path helpers (POSIX semantics; no filesystem access).
  const pathResult = context.evalCode(PATH_SNIPPET, "path.js");
  if (isFail(pathResult)) pathResult.error.dispose();
  else pathResult.value.dispose();

  return () => {
    if (jsonParse.alive) jsonParse.dispose();
  };
}

/** Build a QuickJS value from a plain JSON one; arrays and objects cross once via the context's JSON.parse when given. */
function toHandle(context: QuickJSContext, value: unknown, parseJson?: (text: string) => QuickJSHandle | null): QuickJSHandle {
  if (value === null || value === undefined) return value === undefined ? context.undefined : context.null;
  if (typeof value === "string") return context.newString(value);
  if (typeof value === "number") return context.newNumber(value);
  if (typeof value === "boolean") return value ? context.true : context.false;
  if (parseJson) {
    try {
      const parsed = parseJson(JSON.stringify(value));
      if (parsed) return parsed;
    } catch {
      // Fall through to the recursive build.
    }
  }
  if (Array.isArray(value)) {
    const array = context.newArray();
    value.forEach((item, i) => {
      const handle = toHandle(context, item, parseJson);
      context.setProp(array, i, handle);
      handle.dispose();
    });
    return array;
  }
  const object = context.newObject();
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const handle = toHandle(context, item, parseJson);
    context.setProp(object, key, handle);
    handle.dispose();
  }
  return object;
}

/** A thrown QuickJS value as text: an Error's message when it has one, prefixed with the script's own line number when the stack names one. */
function errorText(context: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = context.dump(handle);
  if (dumped && typeof dumped === "object" && "message" in dumped) {
    const message = String((dumped as { message: unknown }).message);
    const line = scriptLineOf((dumped as { stack?: unknown }).stack);
    return line !== undefined ? `Line ${line}: ${message}` : message;
  }
  return format(dumped);
}

/** The script's line number from the first script.js frame in a QuickJS stack (the async wrapper adds one line). */
function scriptLineOf(stack: unknown): number | undefined {
  if (typeof stack !== "string") return undefined;
  const m = /script\.js:(\d+)/.exec(stack);
  if (!m) return undefined;
  const line = Number(m[1]) - 1;
  return line >= 1 ? line : undefined;
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

/** The `path` global: pure string helpers with POSIX semantics, no filesystem access. */
const PATH_SNIPPET = String.raw`
globalThis.path = (() => {
  const normalize = (p) => {
    const s = String(p);
    const abs = s.startsWith("/");
    const parts = [];
    for (const seg of s.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
        else if (!abs) parts.push("..");
        continue;
      }
      parts.push(seg);
    }
    const joined = parts.join("/");
    return abs ? "/" + joined : joined || ".";
  };
  const strip = (p) => {
    const s = String(p);
    let end = s.length;
    while (end > 1 && s[end - 1] === "/") end--;
    return s.slice(0, end);
  };
  return {
    join: (...parts) => normalize(parts.filter((x) => typeof x === "string" && x !== "").join("/")),
    normalize,
    dirname: (p) => {
      const s = strip(p);
      const i = s.lastIndexOf("/");
      return i < 0 ? "." : i === 0 ? "/" : s.slice(0, i);
    },
    basename: (p, ext) => {
      const s = strip(p);
      const b = s.slice(s.lastIndexOf("/") + 1);
      return typeof ext === "string" && ext !== "" && b.endsWith(ext) ? b.slice(0, b.length - ext.length) : b;
    },
    extname: (p) => {
      const s = String(p);
      const b = s.slice(s.lastIndexOf("/") + 1);
      const i = b.lastIndexOf(".");
      return i > 0 ? b.slice(i) : "";
    },
  };
})();
`;

/** QuickJS says only "not a function" for tools.shell(); name the tools a script has, since models try tools.bash, tools.ls and tools.cat. */
function explain(message: string, o: CodeToolOptions): string {
  if (/not defined|Cannot find|import|module/i.test(message) && /require|import|module|fs/i.test(message)) {
    return `${message}. The sandbox has no require, import, module or fs: read files with tools.read (a folder lists), search with tools.grep and tools.glob.`;
  }
  if (!/not a function/.test(message)) return message;
  const names = o.tools().map((t) => t.definition.name).filter((n) => !EXCLUDED.has(n));
  return `${message}. A script's tools are: ${names.join(", ")}. Read files with tools.read (a folder lists), search with tools.grep and tools.glob; edits, shell commands and tools that change state (such as design_set_direction) are not available in a script: call those directly as tool calls, not through run_code.`;
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
