import { z } from "zod";
import type { HarnessTool, ToolOutput } from "../agents/types";
import { detectScripts, packageManager, type DevScript } from "./detect";
import type { DevServers, OwnedServer } from "./registry";

function safely(fn: () => Promise<ToolOutput>): Promise<ToolOutput> {
  try {
    return fn().catch((err) => ({ text: err instanceof Error ? err.message : String(err), isError: true }));
  } catch (err) {
    return Promise.resolve({ text: err instanceof Error ? err.message : String(err), isError: true });
  }
}

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

const NO_PROJECT = "No project for this thread.";
const NO_SCRIPT = "No dev/start/serve/preview script in package.json.";

/**
 * The dev-server tools: see what a project's package.json offers, start one
 * as a background server the app owns, and stop only servers it started.
 * `cwdOf` maps a thread's project to its folder.
 */
export function devServerTools(servers: DevServers, cwdOf: (projectId: string) => string | null): HarnessTool[] {
  return [
    define({
      name: "dev_server",
      description:
        "List the project's dev/start/serve/preview scripts and whether each port is already serving, or stop a server CubiQ started. Check this first: open a running server's URL with browser_open instead of starting another.",
      input: {
        action: z.enum(["status", "stop"]).optional().describe("status (default) lists the scripts and their ports; stop ends a CubiQ-owned server"),
        script: z.string().optional().describe("The package.json script name, e.g. dev or preview; stop defaults to the only owned server"),
      },
      autoAllow: true,
      // Stopping an owned server changes state, so it runs alone.
      effect: "mutate",
      run: (args, ctx) =>
        safely(async () => {
          const projectId = ctx?.projectId;
          const cwd = projectId ? cwdOf(projectId) : null;
          if (!projectId || !cwd) return { text: NO_PROJECT, isError: true };
          const detected = detectScripts(cwd);
          const owned = servers.list(projectId).filter((s) => s.exited === null);
          if (args.action === "stop") return stopScript(servers, detected, owned, args.script);
          if (!detected.length) return { text: NO_SCRIPT };
          const lines: string[] = [];
          for (const d of detected) {
            const mine = owned.find((s) => s.script === d.script);
            if (mine) {
              lines.push(`${d.script}: ${d.command} (port ${d.port}) — running (owned by CubiQ, pid ${mine.pid}) — http://localhost:${d.port}`);
              continue;
            }
            const up = await servers.isOpen(d.port);
            lines.push(`${d.script}: ${d.command} (port ${d.port}) — ${up ? `running (not started by CubiQ) — http://localhost:${d.port}` : "not running"}`);
          }
          return { text: lines.join("\n") };
        }),
    }),
    define({
      name: "dev_server_start",
      description:
        "Start one of the project's dev/start/serve/preview scripts as a background server CubiQ owns, and return its URL for browser_open. Start one only when dev_server status shows nothing running on that port.",
      input: { script: z.string().optional().describe("The package.json script name to run; defaults to the first detected one") },
      autoAllow: false,
      effect: "mutate",
      run: (args, ctx) =>
        safely(async () => {
          const projectId = ctx?.projectId;
          const cwd = projectId ? cwdOf(projectId) : null;
          if (!projectId || !cwd) return { text: NO_PROJECT, isError: true };
          const detected = detectScripts(cwd);
          if (!detected.length) return { text: NO_SCRIPT, isError: true };
          const d = args.script ? detected.find((s) => s.script === args.script) : detected[0];
          if (!d) return { text: `No "${args.script}" script. Detected: ${detected.map((s) => s.script).join(", ")}.`, isError: true };
          const server = await servers.start(projectId, cwd, d);
          return { text: `Started ${d.script} (${packageManager(cwd)} run ${d.script}) on http://localhost:${d.port}, pid ${server.pid}. Stop it with dev_server action stop.` };
        }),
    }),
  ];
}

/** Stop the owned server for a script (or the only owned one); refuse anything CubiQ didn't start. */
function stopScript(servers: DevServers, detected: DevScript[], owned: OwnedServer[], script: string | undefined): ToolOutput {
  if (!script) {
    if (!owned.length) return { text: "CubiQ isn't running a dev server for this project." };
    if (owned.length > 1) return { text: `Which one? CubiQ is running: ${owned.map((s) => s.script).join(", ")}.` };
    const only = owned[0]!;
    servers.stop(only.id);
    return { text: `Stopped ${only.script} on http://localhost:${only.port}.` };
  }
  const mine = owned.find((s) => s.script === script);
  if (mine) {
    servers.stop(mine.id);
    return { text: `Stopped ${script} on http://localhost:${mine.port}.` };
  }
  const d = detected.find((s) => s.script === script);
  if (d) return { text: `CubiQ only stops servers it started; ${script} on port ${d.port} wasn't.` };
  return { text: `CubiQ isn't running "${script}".` };
}
