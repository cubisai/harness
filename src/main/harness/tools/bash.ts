// The Bash tool: runs a shell command in the thread's folder, streams output as
// it arrives, and kills the whole process tree on timeout or cancellation.
// shellFor picks the platform's shell: bash/sh on POSIX, Git Bash then PowerShell on Windows.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkCommand } from "../../guard";
import { bound } from "./bound";
import { int, str, ToolError, type NativeTool, type ToolContext, type ToolResult } from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Cap on what a command's output may hold in memory before the oldest is dropped. */
const MAX_MEMORY_BYTES = 10 * 1024 * 1024;

/** The shell command to run a command line with, and its name for messages. */
export interface Shell {
  name: string;
  file: string;
  args: (command: string) => string[];
}

/** The shell this platform should run commands with; Git Bash is preferred on Windows. */
export function shellFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Shell {
  if (platform !== "win32") {
    const bash = existsSync("/bin/bash");
    return { name: bash ? "bash" : "sh", file: bash ? "/bin/bash" : "/bin/sh", args: (command) => ["-c", command] };
  }
  const programFiles = env.ProgramFiles;
  const programFilesX86 = env["ProgramFiles(x86)"];
  const localAppData = env.LOCALAPPDATA;
  const candidates = [
    programFiles ? join(programFiles, "Git", "bin", "bash.exe") : null,
    programFilesX86 ? join(programFilesX86, "Git", "bin", "bash.exe") : null,
    localAppData ? join(localAppData, "Programs", "Git", "bin", "bash.exe") : null,
  ];
  for (const file of candidates) {
    if (file && existsSync(file)) return { name: "Git Bash", file, args: (command) => ["-c", command] };
  }
  return { name: "PowerShell", file: "powershell.exe", args: (command) => ["-NoProfile", "-NonInteractive", "-Command", command] };
}

/** The command's first line, cut to 160 characters for the thread's one-line summary. */
function summarizeCommand(command: string): string {
  const first = command.split(/\r?\n/, 1)[0] ?? "";
  return first.length > 160 ? first.slice(0, 160) : first;
}

/** The model-facing shell tool: guarded before it spawns, killed as a tree on timeout or abort. */
export const bashTool: NativeTool = {
  name: "bash",
  displayName: "Bash",
  description:
    "Run a shell command in the working folder and return its output. Use it for builds, tests, git, and other terminal work; prefer the dedicated file tools for reading and editing files. Output streams as it arrives, and on timeout or cancellation the whole process tree is killed. A command the git guardrail blocks is refused before it runs.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run." },
      timeout: { type: "integer", description: "How long to let it run, in milliseconds (default 120000, max 600000).", minimum: 1, maximum: MAX_TIMEOUT_MS },
      description: { type: "string", description: "A short description of what the command does." },
    },
    required: ["command"],
  },
  access: "shell",
  summarize(args) {
    return summarizeCommand(typeof args.command === "string" ? args.command : "");
  },
  run(args, ctx) {
    return runBash(args, ctx);
  },
};

async function runBash(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = str(args, "command", true);
  const verdict = await checkCommand(ctx.guardScript, "Bash", command);
  if (verdict.blocked) throw new ToolError(`Blocked by the git guardrail: ${verdict.reason}`);
  const timeout = Math.min(Math.max(int(args, "timeout") ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
  const platform = ctx.platform ?? process.platform;
  const shell = shellFor(platform, ctx.env ?? process.env);
  const summary = summarizeCommand(command);
  if (ctx.signal.aborted) throw new ToolError("Stopped.");
  return new Promise<ToolResult>((resolve, reject) => {
    const child = spawn(shell.file, shell.args(command), {
      cwd: ctx.cwd,
      env: ctx.env ?? process.env,
      detached: platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let collected = "";
    let timedOut = false;
    let aborted = false;
    let exited = false;
    const append = (chunk: string): void => {
      collected += chunk;
      if (collected.length > MAX_MEMORY_BYTES) collected = collected.slice(-MAX_MEMORY_BYTES);
      ctx.onOutput?.(chunk);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const killTree = (): void => {
      const pid = child.pid;
      if (pid === undefined || exited) return;
      if (platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        return;
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      const hardKill = setTimeout(() => {
        if (exited) return;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }, 2000);
      hardKill.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeout);
    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      reject(new ToolError(`Failed to start ${shell.name}: ${err.message}`));
    });
    let settled = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      exited = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(new ToolError("Stopped."));
        return;
      }
      const output = bound(collected, ctx, "tail");
      let text = output || "(no output)";
      if (code !== null && code !== 0) text += `\n\nExit code ${code}`;
      if (timedOut) text += `\n\nKilled after ${timeout} ms (timeout).`;
      resolve({
        text,
        isError: timedOut,
        display: { summary, input: { command }, result: { exitCode: timedOut ? null : code, output } },
      });
    };
    child.on("close", (code) => settle(code));
    // A job left running in the background (`server &`) keeps the pipes open after
    // the shell exits; answer shortly after the exit instead of waiting on them.
    child.on("exit", (code) => {
      const grace = setTimeout(() => settle(code), 250);
      grace.unref();
    });
  });
}
