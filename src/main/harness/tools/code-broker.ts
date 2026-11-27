// The one broker behind every run_code: the native agent's and the cubiq MCP
// server's (Claude, Codex, OpenCode v1, ACP agents). A script's tool call is
// traced as a child row of the script's row, authorized when the caller asks,
// run, and its output bounded like any tool result.

import type { ThreadEvent } from "../../../shared/types";
import type { Authorization, LoopTool } from "../loop";
import { bound, boundPreview } from "./bound";
import type { CodeToolOptions } from "./code";

/** At most this many of one script's tool calls run at once; the rest wait their turn. */
export const MAX_IN_FLIGHT = 16;
/** One script's read calls shown as rows; past this, one note row stands in for the rest (a loop can make thousands). Effects are always shown. */
export const MAX_LISTED_CALLS = 40;

export interface CodeBrokerOptions {
  /** The tools a script may call, by definition name. */
  tools: () => LoopTool[];
  /** Puts a row in the thread. */
  emit: (event: ThreadEvent) => void;
  /** Gates one call (ask mode asks); absent = every call runs. */
  authorize?: (tool: LoopTool, args: Record<string, unknown>, summary: string, signal: AbortSignal) => Promise<Authorization>;
  outputDir: string;
  /** The row a script's calls nest under, from the id the script runs as; absent = that id. Undefined = top-level rows. May be async (the driver's row is awaited lazily, on the first emission). */
  parentOf?: (parentId: string) => string | undefined | Promise<string | undefined>;
  maxInFlight?: number;
}

export function createCodeBroker(o: CodeBrokerOptions): CodeToolOptions["broker"] {
  let childCalls = 0;
  const max = o.maxInFlight ?? MAX_IN_FLIGHT;
  let active = 0;
  const waiting: (() => void)[] = [];
  /** A slot, or false when the run stopped first (a stopped run's queued calls never start). */
  const acquire = async (signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return false;
    if (active < max) {
      active += 1;
      return true;
    }
    // A freed slot is handed straight to the next waiter, so the count never overshoots.
    return new Promise<boolean>((resolve) => {
      const take = (): void => {
        signal.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = (): void => {
        const i = waiting.indexOf(take);
        if (i >= 0) waiting.splice(i, 1);
        resolve(false);
      };
      waiting.push(take);
      signal.addEventListener("abort", leave, { once: true });
    });
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  // Calls to a tool that may not overlap (edits, shell: `parallel: false`) run one at a time, in call order.
  let serialTail: Promise<void> = Promise.resolve();
  const serialTurn = (): { ready: Promise<void>; done: () => void } => {
    let done!: () => void;
    const mine = new Promise<void>((resolve) => (done = resolve));
    const ready = serialTail;
    serialTail = ready.then(() => mine);
    return { ready, done };
  };

  const listed = new Map<string, number>();
  return async (name, args, scriptId, signal) => {
    const tool = o.tools().find((t) => t.definition.name === name);
    if (!tool) return { text: `There's no tool named "${name}".`, isError: true };
    let summary: string;
    try {
      summary = tool.summarize(args) || tool.displayName;
    } catch {
      summary = tool.displayName;
    }
    const serial = runsAlone(tool) ? serialTurn() : null;
    let parentId: string | undefined;
    try { parentId = o.parentOf ? await o.parentOf(scriptId) : scriptId; }
    catch (err) { serial?.done(); throw err; }
    const nest = parentId ? { parentId } : {};
    // The row goes up before the permission ask, so a refused call shows in the thread too.
    const toolUseId = `${parentId ?? scriptId}:${++childCalls}`;
    const rowKey = parentId ?? scriptId;
    // Only reads count toward the cap: an edit, a command or a state change always gets its row.
    const effect = runsAlone(tool);
    const n = effect ? 0 : (listed.get(rowKey) ?? 0) + 1;
    if (!effect) listed.set(rowKey, n);
    const shown = effect || n <= MAX_LISTED_CALLS;
    if (n === MAX_LISTED_CALLS + 1) {
      o.emit({ kind: "tool-use", toolUseId: `${rowKey}:more`, name: "Note", summary: `Read calls after the first ${MAX_LISTED_CALLS} run without their own rows`, ...nest });
      o.emit({ kind: "tool-result", toolUseId: `${rowKey}:more`, isError: false, summary: "Not listed", ...nest });
    }
    const emit = (e: Parameters<CodeBrokerOptions["emit"]>[0]): void => {
      if (shown) o.emit(e);
    };
    emit({ kind: "tool-use", toolUseId, name: tool.displayName, summary, ...nest });
    let acquired = false;
    try {
      if (signal.aborted) throw new Error(NOT_STARTED);
      if (o.authorize) {
        const auth = await o.authorize(tool, args, summary, signal);
        if (!auth.ok) {
          emit({ kind: "tool-result", toolUseId, isError: true, summary: oneLine(auth.reason), ...nest });
          return { text: auth.reason, isError: true };
        }
      }
      if (serial) await serial.ready;
      acquired = await acquire(signal);
      if (!acquired || signal.aborted) throw new Error(NOT_STARTED);
      // `script` asks read, glob and grep for plain values; the row shows a bounded copy of the text.
      const result = await tool.run(args, { id: toolUseId, signal, onOutput: () => {}, script: true });
      // A data call's text is only a UI preview: cut it in memory, never a spill file. An unlisted call (41+) skips that work too.
      const text = !shown ? result.text : result.data !== undefined ? boundPreview(result.text) : bound(result.text, { outputDir: o.outputDir, callId: toolUseId });
      emit({ kind: "tool-result", toolUseId, isError: result.isError === true, summary: oneLine(text), payload: result.display?.result ?? text, ...nest });
      return result.data !== undefined ? { text: result.text, isError: result.isError === true, data: result.data } : { text, isError: result.isError === true };
    } catch (err) {
      const text = signal.aborted ? NOT_STARTED : `${tool.displayName} failed: ${err instanceof Error ? err.message : String(err)}`;
      emit({ kind: "tool-result", toolUseId, isError: true, summary: oneLine(text), ...nest });
      return { text, isError: true };
    } finally {
      if (acquired) release();
      serial?.done();
    }
  };
}

/** Edits, shell commands and tools declared `parallel: false` (mutating app tools) may not overlap; reads and fetches may. */
export const runsAlone = (tool: LoopTool): boolean => tool.parallel === false || tool.access === "edit" || tool.access === "shell";

const NOT_STARTED = "Not run: the script was stopped or timed out first.";

const oneLine = (text: string, max = 160): string => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
