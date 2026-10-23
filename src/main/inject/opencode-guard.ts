// The git guardrail for OpenCode. OpenCode's ACP mode has no per-command
// permission callback on every turn, so the guard is a tiny plugin module the
// agent loads from a file:// URL. Its tool.execute.before hook runs the same
// block-dangerous-git.py the other drivers use, reading the script path and the
// Python argv from the child's environment (UNSKILLED_GUARD_SCRIPT and
// UNSKILLED_GUARD_PYTHON); throwing rejects the tool call and returns the
// error text to the model.
// The same hook asks CubiQ before every edit and command (CUBIQ_ASK_URL and
// CUBIQ_ASK_TOKEN, set per process by the ACP driver), so the thread's
// permission mode holds whatever OpenCode's own config allows.

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

function guard(input, output) {
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
}

// CubiQ's permission modes: OpenCode asks over ACP only when its own config
// says so, so every edit and command is put to the app first (CUBIQ_ASK_URL).
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);

function summaryOf(kind, args) {
  if (kind === "execute") return typeof args.command === "string" ? args.command : "";
  for (const key of ["filePath", "file_path", "path"]) if (typeof args[key] === "string") return args[key];
  const patch = typeof args.patchText === "string" ? args.patchText : typeof args.input === "string" ? args.input : "";
  const files = patch.split("\\n").filter((line) => /^[*]{3} (Add|Update|Delete) File: /.test(line)).map((line) => line.replace(/^[*]{3} (Add|Update|Delete) File: /, ""));
  return files.join(", ");
}

async function ask(input, output) {
  const url = process.env.CUBIQ_ASK_URL;
  const token = process.env.CUBIQ_ASK_TOKEN;
  if (!url || !token) return;
  const kind = input.tool === "bash" ? "execute" : EDIT_TOOLS.has(input.tool) ? "edit" : null;
  if (!kind) return;
  const noun = kind === "execute" ? "command" : "edit";
  let decision = null;
  let reason = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ tool: input.tool, kind, summary: summaryOf(kind, output.args || {}), callID: input.callID, sessionID: input.sessionID }),
      // The answer is the user's, so it may take minutes: OpenCode's Bun times a fetch out at 300 s otherwise.
      timeout: false,
    });
    if (res.ok) {
      const answer = await res.json();
      decision = answer.decision;
      if (typeof answer.reason === "string") reason = answer.reason;
    }
  } catch {
    decision = null;
  }
  if (decision === "allow-once" || decision === "allow-always") return;
  // Fail closed: without an answer from the app, nothing runs.
  throw new Error(decision === "deny" ? reason || "The user denied this " + noun + "." : "CubiQ couldn't ask the user about this " + noun + ", so it was blocked.");
}

// A sub-agent's own permission ask (external_directory, webfetch...) never
// reaches ACP, so OpenCode would wait on it for good: the app decides it like
// an edit (Full allows, Ask shows a card) and the plugin replies. The main
// session's asks still go over ACP.
async function answerAsk(client, request) {
  const url = process.env.CUBIQ_ASK_URL;
  const token = process.env.CUBIQ_ASK_TOKEN;
  if (!url || !token || !client || !request || !request.id || !request.sessionID) return;
  let parentID = null;
  try {
    const session = await client.session.get({ path: { id: request.sessionID } });
    parentID = session && session.data ? session.data.parentID : null;
  } catch {
    return;
  }
  if (!parentID) return;
  let decision = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ tool: String(request.permission || ""), kind: "permission", summary: (Array.isArray(request.patterns) ? request.patterns : []).join(", "), callID: request.id, sessionID: request.sessionID }),
      timeout: false,
    });
    if (res.ok) decision = (await res.json()).decision;
  } catch {
    decision = null;
  }
  // Fail closed like an edit: without the app's answer the sub-agent is refused, not left waiting.
  const response = decision === "allow-once" || decision === "allow-always" ? "once" : "reject";
  try {
    await client.postSessionIdPermissionsPermissionId({ path: { id: request.sessionID, permissionID: request.id }, body: { response } });
  } catch {
    // Already answered (or the session is gone): nothing left to do.
  }
}

export default async (ctx) => ({
  "tool.execute.before": async (input, output) => {
    guard(input, output);
    await ask(input, output);
  },
  event: async ({ event }) => {
    if (event && event.type === "permission.asked") await answerAsk(ctx && ctx.client, event.properties);
  },
});
`;

/**
 * The same guard for OpenCode v2 (checked on 2.1.0): a plugin is a package
 * exporting `{ id, setup(ctx) }`, and `ctx.tool.hook("execute.before")` passes
 * one event, `{ tool, input, id, sessionID }`. v2 calls the shell tool "shell"
 * (v1 "bash") and edits take `path`, which summaryOf already reads; throwing
 * still rejects the call. The v1 functions above are reused unchanged.
 */
export const OPENCODE_GUARD_V2_SOURCE = `${OPENCODE_GUARD_SOURCE.slice(0, OPENCODE_GUARD_SOURCE.lastIndexOf("export default"))}export default {
  id: "cubiq.guard",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      const input = { tool: event.tool === "shell" ? "bash" : event.tool, callID: event.id, sessionID: event.sessionID };
      const output = { args: event.input || {} };
      guard(input, output);
      await ask(input, output);
    });
  },
};
`;

/** v2 loads a local plugin only from a directory, as a package. */
const V2_PACKAGE_JSON = `${JSON.stringify({ name: "cubiq-guard", version: "1.0.0", private: true, type: "module", main: "index.mjs", exports: { ".": "./index.mjs" } }, null, 2)}\n`;

/** Write `content` to `file` unless it already holds exactly that. */
function writeIfChanged(file: string, content: string): void {
  let existing: string | null = null;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    // Not written yet.
  }
  if (existing !== content) writeFileSync(file, content);
}

/** Write the plugin into `dir` (rewriting only when the content changed) and return its file:// URL. */
export function ensureOpenCodeGuard(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "opencode-guard.mjs");
  writeIfChanged(file, OPENCODE_GUARD_SOURCE);
  return pathToFileURL(file).href;
}

/** Write the v2 plugin package into `<dir>/cubiq-guard-v2` and return the folder's file:// URL. */
export function ensureOpenCodeGuardV2(dir: string): string {
  const pkg = join(dir, "cubiq-guard-v2");
  mkdirSync(pkg, { recursive: true });
  writeIfChanged(join(pkg, "package.json"), V2_PACKAGE_JSON);
  writeIfChanged(join(pkg, "index.mjs"), OPENCODE_GUARD_V2_SOURCE);
  return pathToFileURL(pkg).href;
}

/**
 * Add the guard plugin to an OpenCode injection plan. The plan is mutated and
 * returned so its sealed toJSON stays attached; a plan that already errored is
 * left alone. The config may be absent (subscription: OpenCode's own settings
 * still load, and plugin arrays concatenate across config layers). Without a
 * script and Python the plugin still asks CubiQ; only the git guard is off.
 */
export function withOpenCodeGuard(
  plan: InjectionPlan,
  guard: { pluginUrl: string; script?: string; python?: string[] | null },
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
  if (guard.script && guard.python?.length) {
    plan.env.UNSKILLED_GUARD_SCRIPT = guard.script;
    plan.env.UNSKILLED_GUARD_PYTHON = JSON.stringify(guard.python);
  }
  return plan;
}
