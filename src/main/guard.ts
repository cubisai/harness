import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Runs skilled's git-guardrails script (skills/git-guardrails/scripts/
 * block-dangerous-git.py) before every shell command the agent issues --
 * the pre-tool hook HARNESS.md asks for. The script is standard-library
 * Python; without a Python interpreter the guard is off and says so once.
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
 * `sh|bash|zsh [-l] -c <quoted>` (nested up to three deep); anything else is
 * returned as is.
 */
export function unwrapShell(command: string): string {
  let current = command.trim();
  for (let depth = 0; depth < 3; depth++) {
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

export function checkCommand(script: string, toolName: string, command: string, timeoutMs = 5000): Promise<GuardVerdict> {
  command = unwrapShell(command);
  const python = findPython();
  if (!python || !existsSync(script)) return Promise.resolve({ blocked: false, reason: "" });
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
