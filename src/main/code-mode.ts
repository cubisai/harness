// Code mode for the agents that take CubiQ's tools over MCP (Claude in-process,
// Codex, OpenCode v1, ACP agents): `run_code` on the cubiq server runs a script
// in the native sandbox. Its tools are ones CubiQ runs itself, and only ones
// that read: the native read/glob/grep, scoped to the thread's folder, and the
// app tools that don't change anything. Each call is a child row of the
// script's row in the thread, through the same broker as the native agent's.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CodeMode, ThreadEvent } from "../shared/types";
import type { HarnessTool } from "./agents/types";
import { appLoopTool } from "./harness/driver";
import type { LoopTool } from "./harness/loop";
import { CODE_DESCRIPTION, createCodeTool, SHOW_NOTE, type ShownWidget } from "./harness/tools/code";
import { scriptEnvelope } from "../shared/genui/widget";
import { createCodeBroker } from "./harness/tools/code-broker";
import { globTool } from "./harness/tools/glob";
import { grepTool } from "./harness/tools/grep";
import { readTool } from "./harness/tools/read";
import type { NativeTool, ToolContext } from "./harness/tools/types";

export const CODE_TOOL = "run_code";

/** Tools a script never gets, even when they only read: no nested scripts or questions. */
const NEVER = new Set([CODE_TOOL, "ask_user"]);

/** App tools a read-only script also skips: search_tools only finds tools for call_mcp_tool, which such a script can't call. */
const SCRIPT_SKIP = new Set(["search_tools"]);

/** The native tools' exact argument names, which models otherwise guess from their own tools (`filePath`). */
const SCRIPT_EXAMPLES = "Arguments: `await tools.read({ path: \"src/a.ts\", offset: 1, limit: 200 })`, `await tools.readMany([\"src/a.ts\", \"src/b.ts\"])`, `await tools.grep({ pattern: \"TODO\", path: \"src\", glob: \"*.ts\", limit: 200, context: 2 })`, `await tools.glob({ pattern: \"**/*.md\", limit: 200 })`; read returns the file's text (or, for a folder, its entries, with folders ending in \"/\"), glob and grep return arrays (an empty one when nothing matches), and `path` has POSIX string helpers (`join`, `dirname`, `basename`, `extname`, `normalize`).";

/** The full tool description `run_code` carries on MCP, Codex dynamicTools, and OpenCode v2's top-level plugin tool. */
export const CODE_MODE_DESCRIPTION = `${CODE_DESCRIPTION} Scripts here only read: \`tools\` holds read, glob, grep and CubiQ's read-only tools, scoped to this thread's folder; make edits, run commands and ask questions yourself. ${SCRIPT_EXAMPLES}`;

/** How long a script waits for the agent's driver to show its row before its calls go up as top-level rows. */
const PARENT_WAIT_MS = 2000;

/** Per-thread code mode: read from settings the first time a thread asks, then fixed for this app run, so a session's tool list never changes. */
export function codeModes(read: () => CodeMode | undefined): ((threadId: string) => CodeMode) & { forget(threadId: string): void } {
  const fixed = new Map<string, CodeMode>();
  const modeOf = (threadId: string): CodeMode => {
    let mode = fixed.get(threadId);
    if (!mode) fixed.set(threadId, (mode = read() ?? "off"));
    return mode;
  };
  return Object.assign(modeOf, { forget: (threadId: string) => void fixed.delete(threadId) });
}

export interface CodeServerDeps {
  /** The thread's folder (its worktree or its project's), or null when the thread is gone. */
  cwdOf(threadId: string): string | null;
  projectOf(threadId: string): string | undefined;
  /** The thread's app tools; only the ones that just read reach scripts. */
  appTools(threadId: string): HarnessTool[];
  /** The open run_code row a script with this code belongs to, once the agent's driver has shown it. */
  parentOf(threadId: string, code: string): string | undefined;
  /** Puts a row in the thread (dropped when no turn runs there). */
  emit(threadId: string, event: ThreadEvent): void;
  /** The thread's running turn's signal, so Stop ends a script too. */
  turnSignal?(threadId: string): AbortSignal | undefined;
  outputDir: string;
  guardScript: string;
  parentWaitMs?: number;
  /** Inline UI on: scripts may `show()` tables and stats to the user. Read once per thread, with its tool, so the tool list stays fixed. */
  uiBlocks?: () => boolean;
}

/** A native tool run for a script, in the thread's folder. */
function scriptTool(tool: NativeTool, ctxFor: (callId: string, signal: AbortSignal) => ToolContext): LoopTool {
  return {
    definition: { name: tool.name, description: tool.description, parameters: tool.parameters },
    ...(tool.returns ? { returns: tool.returns } : {}),
    displayName: tool.displayName,
    access: tool.access,
    summarize: (args) => tool.summarize(args),
    run: (args, call) => tool.run(args, { ...ctxFor(call.id, call.signal), ...(call.script ? { script: true } : {}) }),
  };
}

/** Whether an app tool only reads: its declared effect, else the legacy rule (safe to run unasked). */
const readsOnly = (t: HarnessTool): boolean => !NEVER.has(t.name) && (t.effect ? t.effect === "read" : t.autoAllow);

/**
 * `run_code` for one thread, for the cubiq MCP server (`?c=<threadId>`) and
 * Claude's in-process server. Read-only: a script can't write, edit, run
 * commands or ask; the agent does those itself.
 */
export function createCodeServer(deps: CodeServerDeps): { tool(threadId: string): HarnessTool; forget(threadId: string): void } {
  const states = new Map<string, Map<string, string>>();
  const reads = new Map<string, Map<string, number>>();
  const tools = new Map<string, HarnessTool>();

  const scriptTools = (threadId: string, cwd: string): LoopTool[] => {
    let seen = reads.get(threadId);
    if (!seen) reads.set(threadId, (seen = new Map()));
    const fileReads = seen;
    const ctxFor = (callId: string, signal: AbortSignal): ToolContext => ({ cwd, signal, outputDir: deps.outputDir, callId, reads: fileReads, guardScript: deps.guardScript });
    const projectId = deps.projectOf(threadId);
    const ids = { threadId, ...(projectId ? { projectId } : {}) };
    return [
      ...[readTool, globTool, grepTool].map((t) => scriptTool(t, ctxFor)),
      ...deps.appTools(threadId).filter((t) => readsOnly(t) && !SCRIPT_SKIP.has(t.name)).map((t) => appLoopTool(t, ids, deps.outputDir)),
    ];
  };

  const run = async (threadId: string, code: string, signal: AbortSignal | undefined, parentId: string | undefined, canShow: boolean): Promise<{ text: string; isError?: boolean }> => {
    const cwd = deps.cwdOf(threadId);
    if (!cwd) return { text: "This thread's folder is gone, so run_code can't run here.", isError: true };
    const turn = deps.turnSignal?.(threadId);
    const stop = [signal, turn].filter((s): s is AbortSignal => Boolean(s));
    const combined = stop.length ? AbortSignal.any(stop) : new AbortController().signal;
    // The sandbox boots at once; the driver's row is awaited only when the
    // script's first call is about to emit (or resolved immediately when known).
    let parentPromise: Promise<string | undefined> | null = null;
    const parent = (): Promise<string | undefined> =>
      parentId !== undefined ? Promise.resolve(parentId) : (parentPromise ??= waitFor(() => deps.parentOf(threadId, code), deps.parentWaitMs ?? PARENT_WAIT_MS, combined));
    let state = states.get(threadId);
    if (!state) states.set(threadId, (state = new Map()));
    const available = scriptTools(threadId, cwd);
    const sandbox = createCodeTool({
      tools: () => available,
      outputDir: deps.outputDir,
      state,
      broker: createCodeBroker({ tools: () => available, emit: (e) => deps.emit(threadId, e), outputDir: deps.outputDir, parentOf: () => parent() }),
      ...(canShow
        ? {
            show: async (widgets: ShownWidget[], callId: string) => {
              // The widget belongs to the agent's run_code row; without one (it never showed), the sandbox's own id.
              const owner = (await parent()) ?? callId;
              widgets.forEach((w, i) => deps.emit(threadId, { kind: "widget", envelope: scriptEnvelope(w.spec, owner, i, w.complete) }));
            },
          }
        : {}),
    });
    const result = await sandbox.run({ code }, { id: `code-${randomUUID().slice(0, 8)}`, signal: combined, onOutput: () => {} });
    return { text: result.text, ...(result.isError ? { isError: true } : {}) };
  };

  return {
    tool(threadId) {
      let tool = tools.get(threadId);
      if (!tool) {
        const canShow = deps.uiBlocks?.() === true;
        tool = {
          name: CODE_TOOL,
          description: canShow ? `${CODE_MODE_DESCRIPTION} ${SHOW_NOTE}` : CODE_MODE_DESCRIPTION,
          input: { code: z.string().describe("The JavaScript to run, as the body of an async function.") },
          autoAllow: true,
          effect: "read",
          run: ({ code }, ctx) => run(threadId, code, ctx?.signal, ctx?.parentId, canShow),
        } satisfies HarnessTool<{ code: z.ZodString }> as unknown as HarnessTool;
        tools.set(threadId, tool);
      }
      return tool;
    },
    /** A deleted thread's script store, read times and tool go with it. */
    forget(threadId) {
      states.delete(threadId);
      reads.delete(threadId);
      tools.delete(threadId);
    },
  };
}

/** Polls `get` until it returns a value, `ms` pass or `signal` aborts. */
async function waitFor<T>(get: () => T | undefined, ms: number, signal: AbortSignal): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const hit = get();
    if (hit !== undefined || Date.now() >= end || signal.aborted) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
}
