import { type ChildProcess, type SpawnSyncOptionsWithStringEncoding, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join, normalize } from "node:path";

/**
 * How to start `command args` without a shell re-splitting the arguments.
 * On Windows a bare name ("codex", "opencode", "dsh") is usually an npm .cmd
 * shim that only cmd.exe can run, and Codex's `-c` values carry quotes and
 * spaces. So: resolve the name on PATH; run an .exe directly; run a .cmd/.bat
 * through cmd.exe with every argument escaped for it — twice, because the
 * shim re-parses its arguments through `%*`. The escaping is cross-spawn's
 * (https://qntm.org/cmd). Elsewhere the command runs as given.
 */
export interface Launch {
  command: string;
  args: string[];
  /** The line is already escaped for cmd.exe; pass as `windowsVerbatimArguments`. */
  viaCmd: boolean;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/** The file Windows would run for a bare command name, or null. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = (envVar(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const tries = exts.some((e) => e.toLowerCase() === extname(command).toLowerCase()) ? [""] : exts;
  for (const dir of (envVar(env, "PATH") ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of tries) {
      const file = join(dir, command + ext);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

function escapeCmdArg(arg: string): string {
  // Backslashes before a quote, and at the end (before the closing quote), are doubled.
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

export function launchSpec(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Launch {
  if (process.platform !== "win32") return { command, args, viaCmd: false };
  const file = /[\\/]/.test(command) ? command : (findOnPath(command, env) ?? command);
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args, viaCmd: false };
  const line = [normalize(file).replace(CMD_META, "^$1"), ...args.map(escapeCmdArg)].join(" ");
  return { command: envVar(process.env, "COMSPEC") ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], viaCmd: true };
}

/** `spawn` through `launchSpec`. */
export function spawnCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: ("pipe" | "ignore")[] },
): ChildProcess {
  const launch = launchSpec(command, args, opts.env ?? process.env);
  return spawn(launch.command, launch.args, { ...opts, windowsHide: true, windowsVerbatimArguments: launch.viaCmd });
}

/** Like `execFileSync` (utf8, throws with `stderr` on failure), through `launchSpec`. */
export function execCommandSync(command: string, args: string[], opts: Omit<SpawnSyncOptionsWithStringEncoding, "encoding">): string {
  const launch = launchSpec(command, args, opts.env ?? process.env);
  const run = spawnSync(launch.command, launch.args, {
    ...opts,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: launch.viaCmd,
  });
  if (run.error) throw Object.assign(run.error, { stderr: run.stderr });
  if (run.status !== 0) throw Object.assign(new Error(`${command} exited with ${run.status ?? run.signal}`), { stderr: run.stderr });
  return run.stdout;
}

/**
 * Stop a child and everything it started. On Windows `kill()` ends only the
 * direct child — cmd.exe for a shim — and leaves the agent running (holding
 * its working folder open), so the whole tree goes through taskkill —
 * synchronously, so it's done even if the app quits right after.
 */
export function killTree(child: ChildProcess): void {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill();
    return;
  }
  const tk = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
  if (tk.error || tk.status !== 0) child.kill();
}

/**
 * Stop a process tree by pid, for a child already dropped by its owner (an MCP
 * transport's `close` clears the handle before the tree is checked). Windows
 * goes through taskkill as `killTree` does; elsewhere the pid's own signal
 * reaches the child.
 */
export function killPidTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}

/**
 * `reg query HKCU\Environment` output as name → value, with REG_EXPAND_SZ
 * `%NAME%` references expanded against `env`.
 */
export function parseUserEnvironment(output: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s{2,}(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, name, type, raw] = m;
    out[name!] = type === "REG_EXPAND_SZ" ? raw!.replace(/%([^%]+)%/g, (all, v: string) => env[v] ?? out[v] ?? all) : raw!;
  }
  return out;
}

/**
 * Windows only: add the user's environment variables this process started
 * without. An app launched from a terminal opened before a variable was set
 * (say, a provider key an agent's own config reads) otherwise never sees it,
 * while the same app from the Start menu does. Never overrides a variable
 * that is set; the user's Path folders the process lacks (a CLI installed
 * since, like agy) are appended after the ones it has.
 */
export function fillUserEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== "win32") return [];
  const res = spawnSync("reg", ["query", "HKCU\\Environment"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (res.status !== 0 || !res.stdout) return [];
  const added: string[] = [];
  for (const [name, value] of Object.entries(parseUserEnvironment(res.stdout, env))) {
    if (name.toLowerCase() === "path") {
      const merged = mergePath(env.PATH ?? env.Path ?? "", value);
      if (merged !== (env.PATH ?? env.Path ?? "")) {
        env.PATH = merged;
        added.push("PATH");
      }
      continue;
    }
    if (env[name] !== undefined) continue;
    env[name] = value;
    added.push(name);
  }
  return added;
}

/** `current` followed by the folders of `extra` it doesn't already list (compared case- and slash-insensitively). */
export function mergePath(current: string, extra: string): string {
  const key = (d: string) => d.trim().replace(/[\\/]+$/, "").toLowerCase();
  const have = new Set(current.split(";").filter(Boolean).map(key));
  const missing = extra.split(";").filter((d) => d.trim() && !have.has(key(d)) && (have.add(key(d)), true));
  return missing.length ? [current, ...missing].filter(Boolean).join(";") : current;
}
