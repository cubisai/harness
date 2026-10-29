import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { builtInVerdict } from "./guard-rules";

/**
 * Runs skilled's git-guardrails script (skills/git-guardrails/scripts/
 * block-dangerous-git.py) before every shell command the agent issues --
 * the pre-tool hook HARNESS.md asks for. The script is standard-library
 * Python; without it, or without a Python interpreter, the same rules run
 * from guard-rules.ts, so the guard is never silently off.
 */
let pythonCache: string[] | null | undefined;

export function findPython(): string[] | null {
  if (pythonCache !== undefined) return pythonCache;
  const candidates: string[][] =
    process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
  pythonCache = null;
  for (const cmd of candidates) {
    const probe = spawnSync(cmd[0]!, [...cmd.slice(1), "--version"], { encoding: "utf-8" });
    if (probe.status === 0 && /Python 3/.test(`${probe.stdout}${probe.stderr}`)) {
      pythonCache = cmd;
      break;
    }
  }
  return pythonCache;
}

export interface GuardVerdict {
  blocked: boolean;
  reason: string;
}

/**
 * The command a shell wrapper runs. Codex hands approvals over as
 * `/bin/zsh -lc 'git push --force'`, and the guard script matches commands
 * from their start, so it would wave the wrapped form through. Unwraps
 * `sh|bash|zsh [-l] -c <quoted>`, and on Windows `powershell|pwsh [options]
 * -Command <quoted>` (Codex's form there) and `cmd /c <command>`, nested up
 * to three deep; anything else is returned as is.
 */
export function unwrapShell(command: string): string {
  let current = command.trim();
  for (let depth = 0; depth < 3; depth++) {
    const win = unwrapWindowsShell(current);
    if (win !== null) {
      current = win;
      continue;
    }
    const m = /^(?:\S*\/)?(?:ba|z)?sh\s+(?:-[a-z]*c[a-z]*|-l\s+-c|-c)\s+([\s\S]+)$/.exec(current);
    if (!m) break;
    const arg = m[1]!.trim();
    let inner: string | null = null;
    if (arg.startsWith("'") && arg.endsWith("'") && arg.length >= 2) {
      // POSIX single quotes: '\'' closes, escapes a quote, and reopens.
      inner = arg.slice(1, -1).replace(/'\\''/g, "'");
    } else if (arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2) {
      inner = arg.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
    } else if (!/[\s'"]/.test(arg)) {
      inner = arg;
    }
    if (inner === null) break;
    current = inner.trim();
  }
  return current;
}

/**
 * `"C:\...\powershell.exe" -NoProfile -Command 'git push'` → `git push`, and
 * `cmd.exe /d /s /c "git push"` → `git push`; null when it isn't one of those.
 */
function unwrapWindowsShell(command: string): string | null {
  const ps = /^"?(?:[^"\s]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:[\s\S]*?\s)?-(?:Command|c)\s+([\s\S]+)$/i.exec(command);
  if (ps) {
    const arg = ps[1]!.trim();
    // PowerShell quoting: '' is a quote inside single quotes, `" inside double quotes.
    if (arg.startsWith("'") && arg.endsWith("'") && arg.length >= 2) return arg.slice(1, -1).replace(/''/g, "'").trim();
    if (arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2) return arg.slice(1, -1).replace(/`"/g, '"').replace(/\\"/g, '"').trim();
    return arg;
  }
  const cmd = /^"?(?:[^"\s]*[\\/])?cmd(?:\.exe)?"?\s+(?:\/[a-z]\s+)*\/c\s+([\s\S]+)$/i.exec(command);
  if (cmd) {
    const arg = cmd[1]!.trim();
    return arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2 ? arg.slice(1, -1).trim() : arg;
  }
  return null;
}

/** Pass as the guard script to use the built-in rules (guard-rules.ts) with no Python script. */
export const BUILT_IN_GUARD = "built-in";

export function checkCommand(script: string, toolName: string, command: string, timeoutMs = 5000): Promise<GuardVerdict> {
  command = unwrapShell(command);
  const python = findPython();
  // No script, or no Python to run it: the same rules, ported to TypeScript.
  if (script === BUILT_IN_GUARD || !python || !existsSync(script)) return Promise.resolve(builtInVerdict(command));
  return new Promise((resolve) => {
    const child = spawn(python[0]!, [...python.slice(1), script], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      // Fail closed, like the script itself does on a payload it can't read.
      resolve({ blocked: true, reason: "git guardrail timed out; blocked to be safe" });
    }, timeoutMs);
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ blocked: false, reason: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 2 ? { blocked: true, reason: stderr.trim() } : { blocked: false, reason: "" });
    });
    child.stdin.end(JSON.stringify({ tool_name: toolName, tool_input: { command } }));
  });
}
