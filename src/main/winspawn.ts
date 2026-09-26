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
