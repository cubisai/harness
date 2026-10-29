import type { ChildProcess } from "node:child_process";
import { basename, win32 } from "node:path";
import { defaultShell } from "./terminal";
import { killTree, spawnCommand } from "./winspawn";

/** The outcome of a project's check command. `tail` is the last lines of its combined output. */
export interface CheckResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  tail: string;
}

/** How to run `command` in the user's shell: the file plus the flags that take one command string. */
export function checkShell(command: string, shell = defaultShell()): { file: string; args: string[] } {
  // An absolute Windows path keeps its backslashes, so basename by hand there.
  const name = (shell.file.includes("\\") ? win32.basename(shell.file) : basename(shell.file)).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  if (name === "pwsh" || name === "powershell") return { file: shell.file, args: ["-NoProfile", "-Command", pwshScript(command)] };
  if (name === "cmd") return { file: shell.file, args: ["/d", "/s", "/c", command] };
  // zsh, bash, sh and fish all take a single command string the same way.
  return { file: shell.file, args: ["-l", "-c", command] };
}

/**
 * PowerShell needs `&` to run a quoted program path, and `-Command` turns any native exit code into 0 or 1,
 * so keep the real code (or 1 for a failed cmdlet). Newlines, so a trailing `# comment` can't swallow the suffix.
 */
function pwshScript(command: string): string {
  const run = /^\s*["']/.test(command) ? `& ${command.trimStart()}` : command;
  return `$global:LASTEXITCODE = 0\n${run}\n$ok = $?\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\nif (-not $ok) { exit 1 }`;
}

/** The last `maxLines` lines of `output`, with trailing blanks dropped, cut to `maxChars` from the end. */
export function tailOf(output: string, maxLines = 80, maxChars = 6000): string {
  const lines = output.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const text = lines.slice(-maxLines).join("\n");
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/**
 * Run a project's check command in `cwd` and collect its combined stdout/stderr.
 * A timeout or an abort kills the whole process tree; both settle the promise.
 */
export function runCheck(
  command: string,
  cwd: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CheckResult> {
  const { file, args } = checkShell(command);
  const started = Date.now();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnCommand(file, args, { cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, exitCode: null, timedOut: false, durationMs: Date.now() - started, tail: err instanceof Error ? err.message : String(err) });
      return;
    }
    let output = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const finish = (ok: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ ok, exitCode, timedOut, durationMs: Date.now() - started, tail: tailOf(output) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs ?? 300_000);
    const onAbort = () => {
      aborted = true;
      killTree(child);
      finish(false, null);
    };
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (buf: Buffer) => (output += buf.toString("utf8")));
    child.stderr?.on("data", (buf: Buffer) => (output += buf.toString("utf8")));
    child.on("error", (err) => {
      output += output ? `\n${err.message}` : err.message;
      finish(false, null);
    });
    child.on("close", (code) => finish(code === 0 && !timedOut && !aborted, code));
  });
}
