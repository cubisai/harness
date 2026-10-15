// OpenCode's ACP usage covers only its last model call per turn, so multi-step
// turns undercount. `opencode export <session>` prints every message's tokens;
// we run it after the turn and sum the assistant messages ourselves.
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCommand, killTree } from "../../winspawn";

export interface TurnTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

export function sumExportUsage(stdout: string, sinceMs: number): TurnTokens | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  const root = parsed as { messages?: unknown[] };
  if (!Array.isArray(root?.messages)) return null;
  const out: TurnTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let matched = false;
  for (const msg of root.messages) {
    const info = (msg as { info?: unknown })?.info as { role?: unknown; time?: { created?: unknown }; tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } } } | null | undefined;
    if (!info || info.role !== "assistant") continue;
    const created = (info.time as { created?: unknown } | undefined)?.created;
    if (typeof created !== "number" || created < sinceMs) continue;
    matched = true;
    const t = info.tokens ?? {};
    out.input += num(t.input);
    out.output += num(t.output);
    out.reasoning += num(t.reasoning);
    out.cacheRead += num(t.cache?.read);
    out.cacheWrite += num(t.cache?.write);
  }
  return matched ? out : null;
}

/**
 * Run a command and resolve its stdout, or null on a non-zero exit, a spawn
 * error or a timeout. Stdout goes to a temp file, not a pipe: OpenCode exits
 * without draining a full pipe, so a reader that falls behind gets only 64 KB.
 */
export function runForStdout(command: string, args: string[], env: NodeJS.ProcessEnv | undefined, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "cubiq-export-"));
    const file = join(dir, "out.json");
    let fd: number | null = openSync(file, "w");
    let child: ReturnType<typeof spawnCommand> | null = null;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fd !== null) closeSync(fd);
      fd = null;
      let out: string | null = null;
      try {
        if (ok) out = readFileSync(file, "utf8");
      } catch {
        out = null;
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows can still hold a killed child's handle; the temp dir is left behind.
      }
      resolve(out);
    };
    const timer = setTimeout(() => {
      if (child) killTree(child);
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawnCommand(command, args, { env, stdio: ["ignore", fd, "ignore"] });
    } catch {
      finish(false);
      return;
    }
    child.on("error", () => finish(false));
    child.on("close", (code: number | null) => finish(code === 0));
  });
}

export async function exportTurnUsage(o: {
  command: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  sinceMs: number;
  timeoutMs?: number;
  run?: typeof runForStdout;
}): Promise<TurnTokens | null> {
  const out = await (o.run ?? runForStdout)(o.command, ["export", o.sessionId], o.env, o.timeoutMs ?? 3000);
  return out === null ? null : sumExportUsage(out, o.sinceMs);
}
