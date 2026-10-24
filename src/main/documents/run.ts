import { spawn } from "node:child_process";

export interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const CAP = 64 * 1024;

/**
 * Runs a bundled document script with the app's own Node (Electron as Node),
 * resolving its packages from `packagesRoot`, so no agent needs npm, network
 * or access to the skill folder. A non-zero exit is a result, not a throw.
 */
export function runDocScript(script: string, args: string[], cwd: string, packagesRoot: string, timeoutMs = 120_000): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CUBIQ_DOC_TOOLS: packagesRoot },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < CAP) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < CAP) stderr += d.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    });
  });
}
