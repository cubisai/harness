import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { killPidTree, spawnCommand } from "../winspawn";
import { packageManager, type DevScript } from "./detect";

/** How many output lines a server keeps. */
const MAX_OUTPUT_LINES = 200;
/** How often we ask whether the server's port is up yet. */
const POLL_MS = 300;
/** How many output lines an error message quotes. */
const TAIL_LINES = 20;

function probeHost(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Whether something is listening on this loopback port (IPv4 first, then IPv6). */
export async function portOpen(port: number, timeoutMs = 400): Promise<boolean> {
  if (await probeHost("127.0.0.1", port, timeoutMs)) return true;
  return probeHost("::1", port, timeoutMs);
}

/** A dev server this app started, so it may also stop it. */
export interface OwnedServer {
  id: string;
  projectId: string;
  cwd: string;
  script: string;
  port: number;
  pid: number;
  startedAt: number;
  /** Last 200 stdout/stderr lines. */
  output: string[];
  /** Exit code, or null while running. */
  exited: number | null;
}

type SpawnFn = (cmd: string, args: string[], cwd: string) => ChildProcess;

/** `pm run <script>` in the project; a POSIX child leads its own process group so `stop` can signal the tree. */
function defaultSpawn(cmd: string, args: string[], cwd: string): ChildProcess {
  const env = { ...process.env, BROWSER: "none", FORCE_COLOR: "0" };
  const stdio: ("pipe" | "ignore")[] = ["ignore", "pipe", "pipe"];
  if (process.platform === "win32") return spawnCommand(cmd, args, { cwd, env, stdio });
  return spawnChild(cmd, args, { cwd, env, stdio, detached: true });
}

const tail = (lines: string[]): string => (lines.length ? lines.slice(-TAIL_LINES).join("\n") : "(no output)");

/**
 * The dev servers the app started, one per project+script. Only these can be
 * stopped: a server the user runs elsewhere is merely seen on its port.
 */
export class DevServers {
  private servers = new Map<string, OwnedServer>();
  private spawnFn: SpawnFn;
  private probe: (port: number) => Promise<boolean>;
  private readyTimeoutMs: number;

  constructor(opts: { spawn?: SpawnFn; probe?: (port: number) => Promise<boolean>; readyTimeoutMs?: number } = {}) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.probe = opts.probe ?? portOpen;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  }

  /** Whether anything is listening on a port now (the injected probe, so callers share it). */
  isOpen(port: number): Promise<boolean> {
    return this.probe(port);
  }

  /** The owned servers, copies without the process handle, for one project or all. */
  list(projectId?: string): OwnedServer[] {
    const out: OwnedServer[] = [];
    for (const s of this.servers.values()) {
      if (projectId !== undefined && s.projectId !== projectId) continue;
      out.push({ ...s, output: [...s.output] });
    }
    return out;
  }

  /** Start `pm run <script>` and resolve once its port is up. */
  async start(projectId: string, cwd: string, d: DevScript): Promise<OwnedServer> {
    const id = `${projectId}:${d.script}`;
    const existing = this.servers.get(id);
    if (existing && existing.exited === null) {
      throw new Error(`Already running: ${d.script} on port ${d.port} (owned by CubiQ).`);
    }
    if (await this.probe(d.port)) {
      throw new Error(`Port ${d.port} is already in use; a server is probably running there. Open http://localhost:${d.port} instead of starting another.`);
    }
    const child = this.spawnFn(packageManager(cwd), ["run", d.script], cwd);
    const server: OwnedServer = {
      id,
      projectId,
      cwd,
      script: d.script,
      port: d.port,
      pid: child.pid ?? -1,
      startedAt: Date.now(),
      output: [],
      exited: null,
    };
    this.servers.set(id, server);
    const append = (chunk: string): void => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue;
        server.output.push(line);
        if (server.output.length > MAX_OUTPUT_LINES) server.output.shift();
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let pollTimer: NodeJS.Timeout | undefined;
      const stopPolling = (): void => {
        clearTimeout(deadline);
        clearTimeout(pollTimer);
      };
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        stopPolling();
        this.stop(id);
        reject(new Error(`${d.script} didn't open port ${d.port} within ${Math.round(this.readyTimeoutMs / 1000)} s:\n${tail(server.output)}`));
      }, this.readyTimeoutMs);

      child.once("exit", (code) => {
        server.exited = code;
        if (settled) return;
        settled = true;
        stopPolling();
        this.servers.delete(id);
        reject(new Error(`${d.script} exited with code ${code ?? "?"} before port ${d.port} opened:\n${tail(server.output)}`));
      });
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        stopPolling();
        this.servers.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      const poll = async (): Promise<void> => {
        if (settled) return;
        let open = false;
        try {
          open = await this.probe(d.port);
        } catch {
          open = false;
        }
        if (settled) return;
        if (open) {
          settled = true;
          stopPolling();
          resolve();
          return;
        }
        pollTimer = setTimeout(() => void poll(), POLL_MS);
      };
      void poll();
    });
    return { ...server, output: [...server.output] };
  }

  /** Stop an owned server: its process group gets SIGTERM, then SIGKILL after 2 s. Unknown id → false. */
  stop(id: string): boolean {
    const server = this.servers.get(id);
    if (!server) return false;
    this.servers.delete(id);
    // A spawn that failed has no pid; never signal a made-up one (-(-1) would be pid 1).
    if (server.pid <= 0 || server.exited !== null) return true;
    if (process.platform === "win32") {
      killPidTree(server.pid);
      return true;
    }
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    const hardKill = setTimeout(() => {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, 2000);
    hardKill.unref();
    return true;
  }

  /** Stop every owned server (on app quit). */
  stopAll(): void {
    for (const id of [...this.servers.keys()]) this.stop(id);
  }
}
