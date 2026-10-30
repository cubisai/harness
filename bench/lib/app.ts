// Starts and stops the bench's own dev copy of the app (its own profile and
// CDP port, so it never touches the user's app or another session's), and
// reads its database.

import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/main/db";
import { killTree, spawnCommand } from "../../src/main/winspawn";
import type { BenchEvent } from "./metrics";

export const dbPath = (userDataDir: string): string => join(userDataDir, "unskilled.db");

export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

/**
 * The user's own OpenCode `provider` section (TokenHarbor, PGS Grove...) and nothing else, handed over in the child's
 * environment only: the isolated config dir has none of them, and their keys must not be copied into a file.
 */
function userProviders(): Record<string, string> {
  if (process.env.OPENCODE_CONFIG_CONTENT) return {};
  const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "opencode.json");
  try {
    const { provider } = JSON.parse(readFileSync(file, "utf8")) as { provider?: unknown };
    return provider ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider }) } : {};
  } catch {
    return {};
  }
}

export interface App {
  stop(): Promise<void>;
}

/**
 * `bun run dev` from `root` with its own `--user-data-dir`; output goes to `log`.
 * OpenCode (and anything else reading XDG_CONFIG_HOME) gets an empty config dir
 * under the profile, so the user's global agents don't leak in; provider auth
 * lives under XDG_DATA_HOME and stays.
 */
export async function launchApp(o: { root: string; port: number; userDataDir: string; log: string }): Promise<App> {
  if (await portInUse(o.port)) throw new Error(`port ${o.port} is taken: stop that app or pass --attach ${o.port}`);
  mkdirSync(o.userDataDir, { recursive: true });
  const xdgConfig = join(o.userDataDir, "xdg-config");
  mkdirSync(xdgConfig, { recursive: true });
  const out = openSync(o.log, "a");
  const child = spawnCommand("bun", ["run", "dev", "--remoteDebuggingPort", String(o.port), "--", `--user-data-dir=${o.userDataDir}`], {
    cwd: o.root,
    env: { ...process.env, XDG_CONFIG_HOME: xdgConfig, ...userProviders() },
    stdio: ["ignore", out, out],
  });
  return { stop: () => stopApp(child, o.port) };
}

/** Quits gracefully where it can (the Electron process on the port gets SIGTERM, which runs before-quit), then kills the tree. */
async function stopApp(child: ChildProcess, port: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      const pids = execFileSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split(/\s+/).filter(Boolean);
      for (const pid of pids) process.kill(Number(pid), "SIGTERM");
    } catch {
      // Nothing listening any more.
    }
    for (let i = 0; i < 20 && (await portInUse(port)); i++) await new Promise((r) => setTimeout(r, 500));
  }
  killTree(child);
}

/** Registers `path` as a project (the app's own Store code); returns its id. Safe while the app runs (WAL). */
export function registerProject(userDataDir: string, path: string): string {
  mkdirSync(userDataDir, { recursive: true });
  const store = new Store(dbPath(userDataDir));
  try {
    return store.addProject(path).id;
  } finally {
    store.close();
  }
}

function readDb<T>(userDataDir: string, f: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath(userDataDir), { readOnly: true, timeout: 5000 });
  try {
    return f(db);
  } finally {
    db.close();
  }
}

/** The thread's stored events, in order. */
export function threadEvents(userDataDir: string, threadId: string): BenchEvent[] {
  return readDb(userDataDir, (db) =>
    (db.prepare("SELECT payload FROM events WHERE thread_id = ? ORDER BY seq").all(threadId) as { payload: string }[]).map((r) => JSON.parse(r.payload) as BenchEvent),
  );
}

export function threadRow(userDataDir: string, threadId: string): { agent: string | null; model: string | null; permission_mode: string } | undefined {
  return readDb(userDataDir, (db) => db.prepare("SELECT agent, model, permission_mode FROM threads WHERE id = ?").get(threadId) as never);
}
