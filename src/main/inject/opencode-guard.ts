// The git guardrail for OpenCode. OpenCode's ACP mode has no per-command
// permission callback on every turn, so the guard is a tiny plugin module the
// agent loads from a file:// URL. Its tool.execute.before hook runs the same
// block-dangerous-git.py the other drivers use, reading the script path and the
// Python argv from the child's environment (UNSKILLED_GUARD_SCRIPT and
// UNSKILLED_GUARD_PYTHON); throwing rejects the tool call and returns the
// error text to the model.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { InjectionPlan } from ".";

/** The plugin module written to disk. Plain ESM; its only import is a Node builtin. */
export const OPENCODE_GUARD_SOURCE = `import { spawnSync } from "node:child_process";

// Same unwrapping as src/main/guard.ts: a model can hide a command inside
// \`bash -c '...'\`, and the guard script matches commands from their start.
function unwrapShell(command) {
  let current = command.trim();
  for (let depth = 0; depth < 3; depth++) {
    const m = /^(?:\\S*\\/)?(?:ba|z)?sh\\s+(?:-[a-z]*c[a-z]*|-l\\s+-c|-c)\\s+([\\s\\S]+)$/.exec(current);
    if (!m) break;
    const arg = m[1].trim();
    let inner = null;
    if (arg.length >= 2 && arg.startsWith("'") && arg.endsWith("'")) inner = arg.slice(1, -1).split("'\\\\''").join("'");
    else if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) inner = arg.slice(1, -1).replace(/\\\\(["\\\\$\\\`])/g, "$1");
    else if (!/[\\s'"]/.test(arg)) inner = arg;
    if (inner === null) break;
    current = inner.trim();
  }
  return current;
}

export default async () => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "bash") return;
    const raw = output.args && output.args.command;
    if (typeof raw !== "string") return;
    const command = unwrapShell(raw);
    const script = process.env.UNSKILLED_GUARD_SCRIPT;
    const python = process.env.UNSKILLED_GUARD_PYTHON;
    if (!script || !python) return;
    let argv;
    try {
      argv = JSON.parse(python);
    } catch {
      return;
    }
    if (!Array.isArray(argv) || argv.length === 0) return;
    const result = spawnSync(argv[0], argv.slice(1).concat(script), {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.error && result.error.code === "ETIMEDOUT") {
      throw new Error("Blocked by git guardrails: guardrail timed out; blocked to be safe");
    }
    if (result.signal) throw new Error("Blocked by git guardrails: guardrail timed out; blocked to be safe");
    // Any other spawn failure allows the command, like guard.ts failing open.
    if (result.error) return;
    if (result.status === 2) throw new Error("Blocked by git guardrails: " + String(result.stderr || "").trim());
  },
});
`;

/** Write the plugin into `dir` (rewriting only when the content changed) and return its file:// URL. */
export function ensureOpenCodeGuard(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "opencode-guard.mjs");
  let existing: string | null = null;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    // Not written yet.
  }
  if (existing !== OPENCODE_GUARD_SOURCE) writeFileSync(file, OPENCODE_GUARD_SOURCE);
  return pathToFileURL(file).href;
}

/**
 * Add the guard plugin to an OpenCode injection plan. The plan is mutated and
 * returned so its sealed toJSON stays attached; a plan that already errored is
 * left alone. The config may be absent (subscription: OpenCode's own settings
 * still load, and plugin arrays concatenate across config layers).
 */
export function withOpenCodeGuard(
  plan: InjectionPlan,
  guard: { pluginUrl: string; script: string; python: string[] },
): InjectionPlan {
  if (plan.error) return plan;
  const raw = plan.env.OPENCODE_CONFIG_CONTENT;
  let config: Record<string, unknown>;
  if (raw !== undefined) {
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      config = { $schema: "https://opencode.ai/config.json" };
    }
  } else {
    config = { $schema: "https://opencode.ai/config.json" };
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  config.plugin = [...plugins, guard.pluginUrl];
  plan.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  plan.env.UNSKILLED_GUARD_SCRIPT = guard.script;
  plan.env.UNSKILLED_GUARD_PYTHON = JSON.stringify(guard.python);
  return plan;
}
