import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { createInterface } from "node:readline";
import type { ModelOption, PermissionMode } from "../../shared/types";
import { clipSummary, type RunPayload } from "../../shared/tools";
import { normalizeUsage } from "../usage";
import { killTree, spawnCommand } from "../winspawn";
import { AGY_CAPABILITIES } from "./capabilities";
import type { AgentDriver, TurnInput } from "./types";

/**
 * Google Antigravity through its own CLI, `agy`, in print mode with
 * stream-json in and out (checked against agy on Windows, 2026-09-27):
 *
 *   agy --input-format stream-json --output-format stream-json -p=
 *   stdin: {"event":"user","message":{"content":"<prompt>"}}
 *
 * `-p=` (empty) is required: a bare `-p` takes the next flag as its prompt.
 * The prompt goes on stdin, never argv, which Windows caps at 32K characters.
 * stdout is NDJSON: `init` (conversation_id), `step_update` (agent_response
 * text_delta; tool steps ACTIVE/DONE/ERROR with tool_info), and `result`
 * (status, usage, denied_actions). `--conversation <id>` resumes.
 *
 * Headless agy can't ask for approval: its default mode wrote files unasked
 * and auto-denied commands. So Ask runs it read-only (`--mode plan`),
 * Auto-edit is `--mode accept-edits`, and Full skips permissions. There is no
 * pre-tool hook, so the git guard can't run for it (capabilities say so).
 */

export const AGY_DEFAULT_MODEL = "default";
const EFFORTS = ["low", "medium", "high", "max"];

export interface AgyConfig {
  command: string;
  /** Leading arguments, before agy's own (tests run a fake agy through node). */
  args?: string[];
  clientVersion?: string;
  /** The harness guide for a cwd, sent ahead of a new conversation's first prompt. */
  guide?: (cwd: string) => string;
  env?: NodeJS.ProcessEnv;
}

interface StepUpdate {
  step_index?: number;
  state?: "ACTIVE" | "DONE" | "ERROR" | string;
  step_type?: string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: { name?: string; parameters?: Record<string, unknown>; output?: unknown; error?: { type?: string; message?: string } };
}

interface AgyResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number };
  denied_actions?: { action?: string; display_name?: string }[];
}

/** `agy models` output: a "Fetching…" line, then `<id>\t<label>` lines. */
export function parseAgyModels(text: string): ModelOption[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2 && parts[0]!.trim() && !/\s/.test(parts[0]!.trim()))
    .map(([id, label]) => ({ id: id!.trim(), label: label!.trim(), efforts: EFFORTS }));
}

/** The flags that stand in for the harness's permission modes (agy can't prompt headless). */
export function agyPermissionArgs(mode: PermissionMode): string[] {
  if (mode === "full") return ["--dangerously-skip-permissions"];
  if (mode === "auto-edit") return ["--mode", "accept-edits"];
  return ["--mode", "plan"];
}

/** agy's tool names as the harness's canonical rows. */
export function agyTool(name: string, params: Record<string, unknown>, cwd: string): { name: string; summary: string; payload?: RunPayload } {
  const str = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : "");
  const rel = (p: string) => {
    if (!p) return p;
    const r = relative(cwd, p);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r.replace(/\\/g, "/") : p;
  };
  switch (name) {
    case "run_command": {
      const command = str("CommandLine") || str("command");
      return { name: "Run", summary: clipSummary(command), payload: { command } };
    }
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "notebook_edit":
      return { name: "Edit", summary: clipSummary(rel(str("TargetFile") || str("AbsolutePath") || str("path"))) };
    case "view_file":
    case "list_dir":
      return { name: "Read", summary: clipSummary(rel(str("AbsolutePath") || str("DirectoryPath") || str("TargetFile") || str("path"))) };
    case "grep_search":
    case "find_by_name":
    case "search_web":
      return { name: "Search", summary: clipSummary(str("Query") || str("Pattern") || str("SearchPattern") || str("query")) };
    case "read_url_content":
      return { name: "Fetch", summary: clipSummary(str("Url") || str("url")) };
    default:
      return { name, summary: clipSummary(str("Url") || str("url") || str("Query") || "") };
  }
}

export function createAgyDriver(config: AgyConfig): AgentDriver {
  let models: ModelOption[] = [{ id: AGY_DEFAULT_MODEL, label: "Agent default", efforts: EFFORTS }];
  let refreshing: Promise<void> | null = null;
  /** Threads already told that Ask runs read-only. */
  const warnedAsk = new Set<string>();

  const run = (args: string[], cwd: string | undefined) =>
    spawnCommand(config.command, [...(config.args ?? []), ...args], { cwd, env: config.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });

  const refreshModels = (): Promise<void> => {
    refreshing ??= new Promise<void>((resolve) => {
      const child = run(["models"], undefined);
      let out = "";
      const timer = setTimeout(() => killTree(child), 15_000);
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.stdin?.end();
      child.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
      child.on("close", () => {
        clearTimeout(timer);
        const list = parseAgyModels(out);
        if (list.length) models = [models[0]!, ...list];
        resolve();
      });
    }).finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  const runTurn = async (input: TurnInput): Promise<void> => {
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "-p="];
    if (input.sessionId) args.push("--conversation", input.sessionId);
    if (input.model && input.model !== AGY_DEFAULT_MODEL) args.push("--model", input.model);
    if (input.effort && EFFORTS.includes(input.effort)) args.push("--effort", input.effort);
    args.push(...agyPermissionArgs(input.permissionMode));

    if (input.permissionMode === "ask" && !warnedAsk.has(input.threadId)) {
      warnedAsk.add(input.threadId);
      input.onEvent({
        kind: "notice",
        text: "Antigravity can't ask for approval from the app. In Ask it only plans (read-only); use Auto-edit to let it edit files, or Full to also run commands.",
      });
    }

    const guide = !input.sessionId ? config.guide?.(input.cwd) ?? "" : "";
    const prompt = guide ? `<harness-guide>\n${guide}\n</harness-guide>\n\n${input.prompt}` : input.prompt;

    input.onEvent({ kind: "turn-start", turnId: randomUUID(), agent: "antigravity", model: input.model });
    const started = Date.now();
    const child = run(args, input.cwd);
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdin?.end(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);

    const textItem = `agy-text-${randomUUID()}`;
    let text = "";
    const flushText = () => {
      if (!text.trim()) {
        text = "";
        return;
      }
      input.onEvent({ kind: "assistant-text", text: text.replace(/\s+$/, ""), itemId: textItem });
      text = "";
    };
    const announced = new Set<number>();
    const toolIds = new Map<number, string>();
    let result: AgyResult | null = null;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });

    const onLine = (line: string) => {
      let msg: { event?: string; conversation_id?: string; step_update?: StepUpdate; result?: AgyResult };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.event === "init" && msg.conversation_id) {
        input.onSession(msg.conversation_id);
        return;
      }
      if (msg.event === "result" && msg.result) {
        result = msg.result;
        return;
      }
      const s = msg.step_update;
      if (msg.event !== "step_update" || !s) return;
      if (s.step_type === "agent_response" && s.text_delta) {
        text += s.text_delta;
        input.onTextDelta(s.text_delta, textItem);
        return;
      }
      if (s.step_type !== "tool" || s.step_index === undefined) return;
      const name = s.tool_name ?? s.tool_info?.name ?? "tool";
      if (!announced.has(s.step_index)) {
        announced.add(s.step_index);
        flushText();
        const id = `agy-${s.step_index}-${randomUUID().slice(0, 8)}`;
        toolIds.set(s.step_index, id);
        const row = agyTool(name, s.tool_info?.parameters ?? {}, input.cwd);
        input.onEvent({ kind: "tool-use", toolUseId: id, name: row.name, summary: row.summary, ...(row.payload ? { payload: row.payload } : {}) });
      }
      if (s.state === "DONE" || s.state === "ERROR") {
        const id = toolIds.get(s.step_index)!;
        const error = s.tool_info?.error?.message;
        const output = typeof s.tool_info?.output === "string" ? s.tool_info.output : "";
        input.onEvent({
          kind: "tool-result",
          toolUseId: id,
          isError: s.state === "ERROR",
          summary: clipSummary(s.state === "ERROR" ? (error ?? "Failed") : output || "Done"),
        });
      }
    };

    const lines = createInterface({ input: child.stdout! });
    lines.on("line", onLine);
    const exit = await new Promise<number | null>((resolve) => {
      child.on("error", (err) => {
        stderr += String(err);
        resolve(null);
      });
      child.on("close", (code) => resolve(code));
    });
    input.signal.removeEventListener("abort", onAbort);
    flushText();

    if (aborted) {
      input.onEvent({ kind: "notice", text: "Stopped." });
      return;
    }
    const res = result as AgyResult | null;
    if (!res) {
      input.onEvent({ kind: "error", message: `Antigravity stopped without a result${exit !== null ? ` (exit ${exit})` : ""}: ${tail(stderr) || "no output"}` });
      return;
    }
    const denied = (res.denied_actions ?? []).map((a) => a.display_name ?? a.action ?? "an action");
    if (denied.length) {
      input.onEvent({
        kind: "notice",
        text: `Antigravity can't ask for approval from the app, so it skipped: ${[...new Set(denied)].join(", ")}. Switch this thread to Full to let it run them.`,
      });
    }
    if (res.status && res.status !== "SUCCESS") {
      input.onEvent({ kind: "error", message: `Antigravity: ${tail(stderr) || res.status}` });
    }
    const u = res.usage;
    const usage = u
      ? normalizeUsage({
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          reasoningTokens: u.thinking_tokens ?? null,
          cacheReadTokens: u.cache_read_tokens ?? null,
          cacheWriteTokens: null,
          provenance: "reported",
        })
      : normalizeUsage({ inputTokens: 0, outputTokens: 0, provenance: "unavailable" });
    input.onEvent({
      kind: "turn-end",
      costUsd: null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs: Date.now() - started,
      usage,
    });
  };

  return {
    id: "antigravity",
    label: "Antigravity",
    models: () => models,
    defaultModel: AGY_DEFAULT_MODEL,
    capabilities: AGY_CAPABILITIES,
    credentials: { byok: false, own: "login", injector: "acp" },
    skillsDelivery: AGY_CAPABILITIES.skillsDelivery,
    skillCallPrefix: "",
    refreshModels,
    runTurn,
  };
}

function tail(text: string, lines = 3): string {
  return text.trim().split(/\r?\n/).slice(-lines).join(" ").trim();
}
