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

export function checkCommand(script: string, toolName: string, command: string, timeoutMs = 5000): Promise<GuardVerdict> {
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
