// The background-shell tools: start a long-running command, read what it has
// printed, stop it, and list a thread's shells. Every tool acts for one thread,
// so another thread's shell id answers as unknown.

import { z } from "zod";
import type { HarnessTool, ToolOutput } from "./agents/types";
import { checkCommand } from "./guard";
import type { ShellInfo, ShellManager } from "./shells";
import { ShellLimitError } from "./shells";

/** What the shell tools need: the app's manager, the thread's folder, and the guard. */
export interface ShellToolDeps {
  manager: ShellManager;
  cwdOf(threadId: string): string | null;
  guardScript: string;
  /** How long shell_start waits for first output before answering (default 1000 ms). */
  initialWaitMs?: number;
}

/**
 * Why Claude's own background Bash is turned away: its task keeps the SDK query,
 * and with it the turn, open for as long as the process lives, and stopping the
 * turn kills it. shell_start's processes belong to the app instead.
 */
export const BACKGROUND_BASH_DENY =
  "In this app a background Bash keeps your turn open until the process exits. Start long-running commands with the cubiq shell_start tool instead: it returns at once, the process keeps running, and shell_output / shell_stop manage it.";

/** The names of the four background-shell tools. */
export const SHELL_TOOL_NAMES = ["shell_start", "shell_output", "shell_stop", "shell_list"] as const;

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

/** The status as the model reads it: running, stopped, or exited with a code. */
function statusLine(info: ShellInfo): string {
  if (info.status === "running") return "running";
  if (info.status === "stopped") return "stopped";
  return info.exitCode === null ? "exited" : `exited with code ${info.exitCode}`;
}

/** The last `count` lines of a buffer; a trailing newline is not an extra line. */
function lastLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-Math.max(1, Math.trunc(count))).join("\n");
}

/** Wait up to `ms` for the shell to exit, checking every 100 ms. */
async function waitForStart(manager: ShellManager, id: string, ms: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, ms);
  while (Date.now() < deadline) {
    const info = manager.get(id);
    if (!info || info.status !== "running") return;
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** The four shell tools bound to one thread. */
export function shellTools(threadId: string, deps: ShellToolDeps): HarnessTool[] {
  // Another thread's shell answers as unknown: one thread can't read or stop another's.
  const own = (id: string): ShellInfo | null => {
    const info = deps.manager.get(id);
    return info && info.threadId === threadId ? info : null;
  };
  return [
    define({
      name: "shell_start",
      description:
        "Start a long-running command (dev server, watcher, `docker compose up`) in the background in the thread's folder and return at once with its id. Use this instead of `&` or nohup. Read its output later with shell_output and stop it with shell_stop.",
      input: {
        command: z.string().describe("The command line to keep running, e.g. `bun run dev` or `docker compose up`"),
        name: z.string().optional().describe("A short label for the shell, e.g. `dev server`"),
      },
      autoAllow: false,
      effect: "mutate",
      run: async (args): Promise<ToolOutput> => {
        const verdict = await checkCommand(deps.guardScript, "Bash", args.command);
        if (verdict.blocked) return { text: `Blocked by the git guardrail: ${verdict.reason}`, isError: true };
        const cwd = deps.cwdOf(threadId);
        if (!cwd) return { text: "This thread has no folder to run in.", isError: true };
        let info: ShellInfo;
        try {
          info = deps.manager.start(threadId, cwd, args.command, args.name);
        } catch (err) {
          if (err instanceof ShellLimitError) return { text: err.message, isError: true };
          return { text: err instanceof Error ? err.message : String(err), isError: true };
        }
        await waitForStart(deps.manager, info.id, deps.initialWaitMs ?? 1000);
        const current = deps.manager.get(info.id) ?? info;
        const out = deps.manager.output(info.id, { tail: 20 });
        const first = out?.text.trim() ? lastLines(out.text, 20) : "(no output yet)";
        return {
          text: `Started shell ${info.id} ("${info.name}") in the background.\nStatus: ${statusLine(current)}\n--- first output ---\n${first}\n--- end ---\nRead more with shell_output({ id: "${info.id}" }); stop it with shell_stop({ id: "${info.id}" }).`,
        };
      },
    }),
    define({
      name: "shell_output",
      description:
        "Read a background shell's status and output. Pass `since` = the `next` from the last read to get only output that is new since then.",
      input: {
        id: z.string().describe("The shell id from shell_start or shell_list"),
        tail: z.number().int().min(1).max(500).optional().describe("Return only the last this many lines"),
        since: z.number().int().min(0).optional().describe("Return only output after this absolute offset (the `next` from a previous read)"),
      },
      autoAllow: true,
      effect: "read",
      run: (args): Promise<ToolOutput> => {
        if (!own(args.id)) return Promise.resolve({ text: `No shell ${args.id} in this thread.`, isError: true });
        const out = deps.manager.output(args.id, {
          ...(args.since === undefined ? {} : { since: args.since }),
          ...(args.tail === undefined ? {} : { tail: args.tail }),
        });
        if (!out) return Promise.resolve({ text: `No shell ${args.id} in this thread.`, isError: true });
        const body = out.text.trim() ? out.text : "(no output yet)";
        const text = `${out.dropped ? "(older output was dropped)\n" : ""}${body}`;
        return Promise.resolve({
          text: `Shell ${out.info.id} ("${out.info.name}"): ${statusLine(out.info)}\n--- output ---\n${text}\n--- next: ${out.next} ---`,
        });
      },
    }),
    define({
      name: "shell_stop",
      description:
        "Stop a background shell and its whole process tree. Use it when the dev server, watcher or container stack it started is no longer needed.",
      input: { id: z.string().describe("The shell id to stop") },
      autoAllow: true,
      effect: "mutate",
      run: async (args): Promise<ToolOutput> => {
        const before = own(args.id);
        if (!before) return { text: `No shell ${args.id} in this thread.`, isError: true };
        const info = await deps.manager.stop(args.id);
        if (!info) return { text: `No shell ${args.id} in this thread.`, isError: true };
        if (before.status !== "running") {
          return { text: `Shell ${info.id} had already exited (code ${before.exitCode ?? "unknown"}).` };
        }
        return { text: `Stopped shell ${info.id} ("${info.name}").` };
      },
    }),
    define({
      name: "shell_list",
      description: "List the background shells started in this thread, newest first, with their status.",
      input: {},
      autoAllow: true,
      effect: "read",
      run: (): Promise<ToolOutput> => {
        const shells = deps.manager.list(threadId);
        if (!shells.length) return Promise.resolve({ text: "No background shells in this thread." });
        return Promise.resolve({ text: shells.map((s) => `${s.id}  ${statusLine(s)}  ${s.name}  — ${s.command}`).join("\n") });
      },
    }),
  ];
}
