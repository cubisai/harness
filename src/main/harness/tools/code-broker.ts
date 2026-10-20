// The one broker behind every run_code: the native agent's and the cubiq MCP
// server's (Claude, Codex, OpenCode v1, ACP agents). A script's tool call is
// traced as a child row of the script's row, authorized when the caller asks,
// run, and its output bounded like any tool result.

import type { ThreadEvent } from "../../../shared/types";
import type { Authorization, LoopTool } from "../loop";
import { bound } from "./bound";
import type { CodeToolOptions } from "./code";

/** At most this many of one script's tool calls run at once; the rest wait their turn. */
export const MAX_IN_FLIGHT = 8;

export interface CodeBrokerOptions {
  /** The tools a script may call, by definition name. */
  tools: () => LoopTool[];
  /** Puts a row in the thread. */
  emit: (event: ThreadEvent) => void;
  /** Gates one call (ask mode asks); absent = every call runs. */
  authorize?: (tool: LoopTool, args: Record<string, unknown>, summary: string) => Promise<Authorization>;
  outputDir: string;
  /** The row a script's calls nest under, from the id the script runs as; absent = that id. Undefined = top-level rows. */
  parentOf?: (parentId: string) => string | undefined;
  maxInFlight?: number;
}

export function createCodeBroker(o: CodeBrokerOptions): CodeToolOptions["broker"] {
  let childCalls = 0;
  const max = o.maxInFlight ?? MAX_IN_FLIGHT;
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (active < max) {
      active += 1;
      return;
    }
    // A freed slot is handed straight to the next waiter, so the count never overshoots.
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return async (name, args, scriptId, signal) => {
    const tool = o.tools().find((t) => t.definition.name === name);
    if (!tool) return { text: `There's no tool named "${name}".`, isError: true };
    let summary: string;
    try {
      summary = tool.summarize(args) || tool.displayName;
    } catch {
      summary = tool.displayName;
    }
    const parentId = o.parentOf ? o.parentOf(scriptId) : scriptId;
    const nest = parentId ? { parentId } : {};
    // The row goes up before the permission ask, so a refused call shows in the thread too.
    const toolUseId = `${parentId ?? scriptId}:${++childCalls}`;
    o.emit({ kind: "tool-use", toolUseId, name: tool.displayName, summary, ...nest });
    const auth = o.authorize ? await o.authorize(tool, args, summary) : ({ ok: true } as const);
    if (!auth.ok) {
      o.emit({ kind: "tool-result", toolUseId, isError: true, summary: oneLine(auth.reason), ...nest });
      return { text: auth.reason, isError: true };
    }
    await acquire();
    try {
      const result = await tool.run(args, { id: toolUseId, signal, onOutput: () => {} });
      const text = bound(result.text, { outputDir: o.outputDir, callId: toolUseId });
      o.emit({ kind: "tool-result", toolUseId, isError: result.isError === true, summary: oneLine(text), payload: result.display?.result ?? text, ...nest });
      return { text, isError: result.isError === true };
    } catch (err) {
      const text = `${tool.displayName} failed: ${err instanceof Error ? err.message : String(err)}`;
      o.emit({ kind: "tool-result", toolUseId, isError: true, summary: oneLine(text), ...nest });
      return { text, isError: true };
    } finally {
      release();
    }
  };
}

const oneLine = (text: string, max = 160): string => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
