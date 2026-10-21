// Browser tools on demand (Settings › Experiments). Agents without their own
// tool search (Codex, OpenCode, CubiQ's own agents) load every tool definition
// up front, and the browser pane's are most of the app's. Behind this setting
// they get two small tools instead: browser_tools lists the rest with their
// schemas, browser_call runs one. Only tools that run without asking move:
// browser_eval asks, so it stays as it is and no agent's permissions change.

import { z } from "zod";
import type { HarnessTool } from "../agents/types";
import { summarizeToolInput } from "../agents/summarize";

export const BROWSER_TOOLS = "browser_tools";
export const BROWSER_CALL = "browser_call";

/** A browser tool that can move behind browser_call: one that never asks. */
const deferrable = (t: HarnessTool) => t.name.startsWith("browser_") && t.autoAllow;

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

/** The input schema the model sees for a tool, as JSON Schema. */
function schemaOf(tool: HarnessTool): Record<string, unknown> {
  try {
    const { $schema: _schema, ...schema } = z.toJSONSchema(z.object(tool.input), { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    return schema;
  } catch {
    return { type: "object", properties: {} };
  }
}

/** browser_tools and browser_call over these browser tools. */
export function browserPair(deferred: HarnessTool[]): [HarnessTool, HarnessTool] {
  const names = deferred.map((t) => t.name);
  const byName = new Map(deferred.map((t) => [t.name, t]));
  const list = define({
    name: BROWSER_TOOLS,
    description: `The browser pane the user sees (open a URL or the dev server, read the page, click, type, logs, check, screenshot). Returns its tools' descriptions and input schemas; call it once before ${BROWSER_CALL}. Tools: ${names.join(", ")}.`,
    input: {
      name: z.string().optional().describe("One tool's name, to get only its schema"),
    },
    autoAllow: true,
    effect: "read",
    run: async ({ name }) => {
      const picked = name ? deferred.filter((t) => t.name === name) : deferred;
      if (!picked.length) return { text: `No browser tool "${name}". Tools: ${names.join(", ")}.`, isError: true };
      return { text: JSON.stringify(picked.map((t) => ({ name: t.name, description: t.description, inputSchema: schemaOf(t) })), null, 2) };
    },
  });
  const call = define({
    name: BROWSER_CALL,
    description: `Run one browser pane tool from ${BROWSER_TOOLS}, with arguments matching its schema, e.g. {"tool": "browser_open", "arguments": {"url": "http://localhost:5173"}}.`,
    input: {
      tool: z.string().describe(`One of: ${names.join(", ")}`),
      arguments: z.record(z.string(), z.unknown()).optional().describe(`The tool's arguments, per its inputSchema from ${BROWSER_TOOLS}`),
    },
    autoAllow: true,
    // Most of them change the page: run alone, in order.
    effect: "mutate",
    summarize: (args) => summarizeToolInput(BROWSER_CALL, args),
    run: async ({ tool, arguments: args }, ctx) => {
      const inner = byName.get(tool);
      if (!inner) return { text: `No browser tool "${tool}" here. Tools: ${names.join(", ")}.`, isError: true };
      const parsed = z.object(inner.input).safeParse(args ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        return { text: `Invalid arguments for ${tool}: ${issues}. Its schema: ${JSON.stringify(schemaOf(inner))}`, isError: true };
      }
      return inner.run(parsed.data as never, ctx);
    },
  });
  return [list, call];
}

const pairs = new WeakMap<HarnessTool, [HarnessTool, HarnessTool]>();

/**
 * A turn's tools with the browser tools that never ask replaced by browser_tools
 * and browser_call, in the first one's place. The pair is made once per set of
 * browser tools, so its definitions never change between turns (prompt cache).
 */
export function withBrowserOnDemand(tools: HarnessTool[]): HarnessTool[] {
  const deferred = tools.filter(deferrable);
  if (!deferred.length) return tools;
  let pair = pairs.get(deferred[0]!);
  if (!pair) pairs.set(deferred[0]!, (pair = browserPair(deferred)));
  const at = tools.indexOf(deferred[0]!);
  const rest = tools.filter((t) => !deferrable(t));
  return [...rest.slice(0, at), ...pair, ...rest.slice(at)];
}
