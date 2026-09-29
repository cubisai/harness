import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MODEL_TTL_MS } from "./model-ttl";

/** One installed copy of an agent CLI, at the path it was found under. */
export interface BinaryInstall {
  path: string;
  version: string;
}

/** The install that wins, plus every other one found (newest first). */
export interface BinaryResolution extends BinaryInstall {
  others: BinaryInstall[];
}

/**
 * Official install locations worth checking even when they aren't on PATH
 * (Claude Code's native installer, OpenCode's own installer). A preferred
 * path wins a version tie over a PATH entry.
 */
export const PREFERRED: Record<string, string[]> = {
  claude: [join(homedir(), ".local", "bin", "claude")],
  opencode: [join(homedir(), ".opencode", "bin", "opencode")],
};

export interface NewestInstallOptions {
  /** Paths to try before PATH, in order. */
  preferred?: string[];
  /** Environment for the version probe. */
  env?: NodeJS.ProcessEnv;
  /** Reads a candidate's version output; null when it can't be run. May be async. */
  run?: (path: string) => string | null | Promise<string | null>;
  /** Every path a command resolves to, in PATH order. May be async. */
  list?: (command: string) => string[] | Promise<string[]>;
}

/** Major.minor.patch as numbers, or null when the string isn't one. */
function semverParts(version: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The version in `output`'s first ordinary line, or null when there is none.
 * Some CLIs (OpenCode 0.0.55) print a timestamped WARN/ERROR line before, or
 * instead of, the version; those lines are skipped.
 */
export function parseVersion(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    if (/^\d{4}[\/-]\d{2}[\/-]\d{2}/.test(line)) continue;
    if (/\b(?:WARN|ERROR|INFO)\b/.test(line)) continue;
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(line);
    if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  }
  return null;
}

/** Numeric major.minor.patch comparison: negative, zero, or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = semverParts(a) ?? [0, 0, 0];
  const pb = semverParts(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

/** Promisified `execFile`: resolves stdout/stderr, rejects with both attached. */
const execFileAsync = promisify(execFile) as unknown as (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/** Every path `command` resolves to, via `which -a` (unix) or `where` (Windows). */
async function defaultList(command: string): Promise<string[]> {
  const cmd = process.platform === "win32" ? "where" : "which";
  const args = process.platform === "win32" ? [command] : ["-a", command];
  try {
    const { stdout } = await execFileAsync(cmd, args, { encoding: "utf8" });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // `which -a` exits non-zero when nothing is found.
    return [];
  }
}

/** `<path> --version`'s stdout+stderr, or null when it can't be run. */
async function defaultRun(path: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(path, ["--version"], { encoding: "utf8", timeout: 5000, env });
    return `${stdout}${stderr}`;
  } catch (err) {
    // A non-zero exit can still carry a version on stdout/stderr; a spawn
    // failure (ENOENT, EACCES) carries neither, so it is skipped.
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    return output || null;
  }
}

/**
 * The newest installed copy of `command`. Candidates are the preferred
 * official paths (first) then everything on PATH, each kept at the path it was
 * found under (so a Windows .cmd shim or npm symlink spawns as usual) and
 * deduped by real path. Copies whose `--version` can't be read are skipped.
 *
 * The PATH lookup and every `--version` probe run asynchronously, in parallel,
 * so this never blocks the caller.
 */
export async function newestInstallAsync(command: string, opts: NewestInstallOptions = {}): Promise<BinaryResolution | null> {
  const list = opts.list ?? defaultList;
  const preferred = opts.preferred ?? PREFERRED[command] ?? [];
  const run = opts.run ?? ((path: string): string | null | Promise<string | null> => defaultRun(path, opts.env));
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      real = path;
    }
    if (seen.has(real)) return;
    seen.add(real);
    candidates.push(path);
  };
  for (const path of preferred) if (existsSync(path)) add(path);
  for (const path of await list(command)) add(path);

  // Probe every candidate at once: the slow part is the process spawn, not the
  // ordering, which is restored below from the candidate list.
  const probed = await Promise.all(candidates.map(async (path) => ({ path, output: await run(path) })));
  const parsed: BinaryInstall[] = [];
  for (const { path, output } of probed) {
    if (output === null) continue;
    const version = parseVersion(output);
    if (version) parsed.push({ path, version });
  }
  if (!parsed.length) return null;
  // Ties keep the earlier candidate: preferred paths, then PATH order.
  let best = parsed[0]!;
  for (const candidate of parsed) if (compareVersions(candidate.version, best.version) > 0) best = candidate;
  return { ...best, others: parsed.filter((c) => c !== best).sort((a, b) => compareVersions(b.version, a.version)) };
}

interface CachedResolution {
  value: BinaryResolution | null;
  at: number;
}

const resolutions = new Map<string, CachedResolution>();
/** In-flight resolutions, so concurrent callers share one probe. */
const inflight = new Map<string, Promise<BinaryResolution | null>>();

/** The cached resolution when it's still within MODEL_TTL_MS, else null. */
function fresh(command: string, now: number): CachedResolution | null {
  const hit = resolutions.get(command);
  return hit && now - hit.at < MODEL_TTL_MS ? hit : null;
}

/**
 * Resolve `command` once and cache it. Concurrent callers share the same probe;
 * a probe that throws is not cached, so the next call retries.
 */
function refresh(command: string): Promise<BinaryResolution | null> {
  const running = inflight.get(command);
  if (running) return running;
  const probe = newestInstallAsync(command)
    .then((value) => {
      resolutions.set(command, { value, at: Date.now() });
      return value;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(command);
    });
  inflight.set(command, probe);
  return probe;
}

/**
 * The install `command` resolves to, memoized for MODEL_TTL_MS. Never probes on
 * the caller's thread: it returns the cached value (undefined before the first
 * resolution, null once one found nothing) and, when missing or stale, starts a
 * background resolution.
 */
export function binaryInfo(command: string, now: number = Date.now()): BinaryResolution | null | undefined {
  if (fresh(command, now)) return resolutions.get(command)!.value;
  void refresh(command);
  return resolutions.get(command)?.value;
}

/** Resolve every `command` (in parallel) so `binaryInfo` has an answer for each. */
export async function warmBinaries(commands: string[]): Promise<void> {
  await Promise.all(
    commands.map((command) => {
      const hit = fresh(command, Date.now());
      return hit ? Promise.resolve(hit.value) : refresh(command);
    }),
  );
}

/**
 * The newest install's path, or `command` unchanged when nothing parses, so a
 * caller passes it straight to a spawn. Awaits the (possibly in-flight)
 * resolution, so it never blocks the event loop on a probe.
 */
export async function resolvedCommandAsync(command: string): Promise<string> {
  const hit = fresh(command, Date.now());
  const value = hit ? hit.value : await refresh(command);
  return value?.path ?? command;
}
