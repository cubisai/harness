// A headless browser for background and test work: the agent-browser CLI, one
// isolated session per job. It answers in the same text shapes as the visible
// pane, so the browser tools and the model see no difference.
//
// The CLI keeps a daemon per session: a call is one short process that prints a
// single JSON line { success, data, error }. Spawn the binary itself (no shell),
// wait for "exit" (the daemon can hold the pipes open), and kill on timeout.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DevicePreset } from "../../shared/types";
import {
  hasWait,
  NO_LOGS,
  NO_NEW_LOGS,
  scopeLines,
  staleRefMessage,
  waitNote,
  waitUntil,
  type BrowserBackend,
  type RefPrint,
  type SnapshotOptions,
  type WaitFor,
} from "./backend";

/** The CLI versions this adapter speaks (its JSON shapes were checked against 0.27). */
export const SUPPORTED = { min: "0.27.0", maxMajor: 0 };

const EVAL_MAX = 4000;

/** One CLI call's JSON line. */
interface CliReply {
  success?: boolean;
  data?: unknown;
  error?: string | null;
}

export type RunCli = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** The agent-browser command: on Windows the npm package's own exe (its shim is a .cmd), elsewhere the PATH name; null when not installed. */
export function resolveAgentBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "win32") return "agent-browser";
  const appData = env.APPDATA;
  if (!appData) return null;
  const exe = join(appData, "npm", "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe");
  return existsSync(exe) ? exe : null;
}

/** Run the CLI once; resolves on exit (never on pipe close), kills it after timeoutMs. */
export function cliRunner(command: string, timeoutMs: number): RunCli {
  return (args) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let done = false;
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill();
        resolve({ code: null, stdout, stderr: `${stderr}\nagent-browser timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      child.stdout?.on("data", (d) => (stdout += String(d)));
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: err.message });
      });
      child.on("exit", (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
}

/** "agent-browser 0.27.0" → "0.27.0"; null when unreadable. */
export function parseVersion(text: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0] ?? null;
}

/** Whether this adapter speaks that CLI version. */
export function supported(version: string | null): boolean {
  if (!version) return false;
  const [maj, min, pat] = version.split(".").map(Number) as [number, number, number];
  const [rmaj, rmin, rpat] = SUPPORTED.min.split(".").map(Number) as [number, number, number];
  if (maj > SUPPORTED.maxMajor) return false;
  return maj > rmaj || (maj === rmaj && (min > rmin || (min === rmin && pat >= rpat)));
}

export async function agentBrowserVersion(run: RunCli): Promise<string | null> {
  const r = await run(["--version"]);
  return parseVersion(r.stdout);
}

interface Snapshot {
  origin?: string;
  refs?: Record<string, { name?: string; role?: string }>;
  snapshot?: string;
}

/** The headless snapshot in the visible pane's shape: `Page:`/`URL:`, scope lines, then one `[eN] role "name"` line per ref. */
export function formatHeadlessSnapshot(data: Snapshot, title: string, url: string, opts?: SnapshotOptions): string {
  const refs = Object.entries(data.refs ?? {}).sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)));
  const lines = [`Page: ${title}`, `URL: ${url}`, ...scopeLines(opts)];
  for (const [ref, node] of refs) lines.push(`[${ref}] ${node.role ?? "node"}${node.name ? ` "${node.name}"` : ""}`);
  if (!refs.length) lines.push(data.snapshot?.trim() || "(no visible content)");
  return lines.join("\n");
}

/** "e7" or "@e7" → "@e7", as the CLI takes it. */
const atRef = (ref: string): string => (ref.startsWith("@") ? ref : `@${ref}`);
const bareRef = (ref: string): string => ref.replace(/^@/, "");

export class AgentBrowserBackend implements BrowserBackend {
  readonly kind = "headless" as const;
  private readonly run: RunCli;
  private checked: Promise<void> | null = null;
  private shots = 0;
  private title = "";
  /** The highest ref number handed out; the CLI renumbers e1… per snapshot, so ours never repeat. */
  private issued = 0;
  /** The latest snapshot's model ref → CLI ref. */
  private current = new Map<string, string>();
  /** Every handed-out ref's kind and name, to recognise it after it goes stale. */
  private prints = new Map<string, RefPrint>();
  /** Matching log lines already returned, for newOnly reads. */
  private seenConsole = 0;
  private seenErrors = 0;

  constructor(
    private o: {
      /** The isolation boundary: each headless job gets its own. */
      session: string;
      command?: string;
      screenshotDir: string;
      timeoutMs?: number;
      run?: RunCli;
    },
  ) {
    const command = o.command ?? resolveAgentBrowser();
    this.run = o.run ?? (command ? cliRunner(command, o.timeoutMs ?? 30_000) : async () => ({ code: null, stdout: "", stderr: "agent-browser isn't installed" }));
  }

  /** One CLI call in this session; the last JSON line's data, or the error it reported. */
  private async call<T = Record<string, unknown>>(...args: string[]): Promise<T> {
    await this.versionChecked();
    const r = await this.run(["--session", this.o.session, "--json", ...args]);
    const line = r.stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
    let parsed: CliReply | null = null;
    try {
      parsed = line ? (JSON.parse(line) as CliReply) : null;
    } catch {
      parsed = null;
    }
    if (!parsed) throw new Error(`agent-browser ${args[0]} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || "no output"}`);
    if (parsed.success !== true) throw new Error(parsed.error || `agent-browser ${args[0]} failed`);
    return (parsed.data ?? {}) as T;
  }

  /** The version gate, once per backend; an unsupported CLI is refused with what to install. */
  private versionChecked(): Promise<void> {
    this.checked ??= agentBrowserVersion(this.run).then((v) => {
      if (!supported(v)) throw new Error(`agent-browser ${v ?? "(not found)"} isn't supported: install ${SUPPORTED.min} or a later 0.x release.`);
    });
    return this.checked;
  }

  async ensureOpen(): Promise<void> {
    await this.versionChecked();
  }

  async open(url: string, device?: DevicePreset, wait?: WaitFor): Promise<string> {
    if (device === "mobile") await this.call("set", "viewport", "390", "844");
    else if (device === "tablet") await this.call("set", "viewport", "768", "1024");
    const data = await this.call<{ title?: string }>("open", url);
    this.title = data.title ?? "";
    // A navigation makes every earlier ref stale.
    this.current = new Map();
    this.seenConsole = 0;
    this.seenErrors = 0;
    if (!hasWait(wait)) return "";
    const r = await this.awaitCondition(wait);
    return waitNote(wait, r, await this.url());
  }

  /** Wait on a condition in the page: the CLI's eval awaits the promise and returns `{ result }`. */
  private awaitCondition(wait: WaitFor): Promise<{ met: boolean; ms: number }> {
    return waitUntil((expression) => this.call<{ result?: unknown }>("eval", expression).then((d) => d.result), wait);
  }

  private async url(): Promise<string> {
    const data = await this.call<{ url?: string; result?: string }>("get", "url");
    return data.url ?? data.result ?? "";
  }

  async snapshot(opts?: SnapshotOptions): Promise<string> {
    const args = ["snapshot", ...(opts?.interactive ? ["-i"] : []), ...(opts?.selector ? ["-s", opts.selector] : [])];
    const data = await this.call<Snapshot>(...args);
    const title = await this.call<{ title?: string; result?: string }>("get", "title").then((d) => d.title ?? d.result ?? this.title, () => this.title);
    const url = data.origin ?? (await this.url());
    const refs = Object.entries(data.refs ?? {}).sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)));
    // Hand out our own refs, offset past every one already issued, so a CLI ref
    // reused by the next snapshot (it always renumbers e1…) can't retarget an old ref.
    const current = new Map<string, string>();
    const rekeyed: NonNullable<Snapshot["refs"]> = {};
    let max = 0;
    for (const [cliRef, node] of refs) {
      const n = Number(cliRef.slice(1));
      if (n > max) max = n;
      const model = `e${this.issued + n}`;
      current.set(model, cliRef);
      rekeyed[model] = node;
      this.prints.set(model, { kind: node.role ?? "node", name: node.name ?? "" });
      if (this.prints.size > 2000) this.prints.delete(this.prints.keys().next().value!);
    }
    this.issued += max;
    this.current = current;
    return formatHeadlessSnapshot(refs.length ? { ...data, refs: rekeyed } : data, title, url, opts);
  }

  /** The CLI ref behind a model ref, or the stale-ref error naming the same-kind-and-name refs on the page now (a fresh snapshot). */
  private async resolveRef(ref: string): Promise<string> {
    const bare = bareRef(ref);
    const cli = this.current.get(bare);
    if (cli) return cli;
    const print = this.prints.get(bare);
    if (!print) throw new Error(staleRefMessage(bare, undefined, []));
    await this.snapshot();
    const matches = [...this.current.keys()].filter((m) => {
      const p = this.prints.get(m);
      return p?.kind === print.kind && p.name === print.name;
    });
    throw new Error(staleRefMessage(bare, print, matches));
  }

  async click(ref: string, wait?: WaitFor): Promise<string> {
    await this.call("click", atRef(await this.resolveRef(ref)));
    let out = `Clicked ${bareRef(ref)}. Now at ${await this.url()}`;
    if (hasWait(wait)) out += `\n${waitNote(wait, await this.awaitCondition(wait), await this.url())}`;
    return out;
  }

  async type(ref: string, text: string, submit: boolean, wait?: WaitFor): Promise<string> {
    await this.call("fill", atRef(await this.resolveRef(ref)), text);
    if (submit) await this.call("press", "Enter");
    let out = `Typed into ${bareRef(ref)}${submit ? " and pressed Enter" : ""}. Now at ${await this.url()}`;
    if (hasWait(wait)) out += `\n${waitNote(wait, await this.awaitCondition(wait), await this.url())}`;
    return out;
  }

  async evaluate(expression: string): Promise<string> {
    const data = await this.call<{ result?: unknown }>("eval", expression);
    const value = "result" in data ? data.result : data;
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
    return text.length > EVAL_MAX ? `${text.slice(0, EVAL_MAX)}… (truncated)` : text;
  }

  /** A raw eval result for the harness itself, not the agent's browser_eval. */
  async query(expression: string): Promise<unknown> {
    return (await this.call<{ result?: unknown }>("eval", expression)).result;
  }

  async logs(clear: boolean, newOnly = false): Promise<string> {
    const flag = clear ? ["--clear"] : [];
    const consoleData = await this.call<{ messages?: { type?: string; level?: string; text?: string }[] }>("console", ...flag);
    const errorData = await this.call<{ errors?: { message?: string; text?: string }[] }>("errors", ...flag).catch(() => ({ errors: [] }));
    const consoleLines = (consoleData.messages ?? []).filter((m) => ["error", "warning", "warn", "assert"].includes(m.type ?? m.level ?? "")).map((m) => `[${m.type ?? m.level}] ${m.text ?? ""}`);
    const errorLines = (errorData.errors ?? []).map((e) => `[error] ${e.message ?? e.text ?? ""}`);
    const lines = newOnly ? [...consoleLines.slice(this.seenConsole), ...errorLines.slice(this.seenErrors)] : [...consoleLines, ...errorLines];
    this.seenConsole = clear ? 0 : consoleLines.length;
    this.seenErrors = clear ? 0 : errorLines.length;
    return lines.length ? lines.join("\n") : newOnly ? NO_NEW_LOGS : NO_LOGS;
  }

  async screenshot(): Promise<{ path: string; png: Buffer }> {
    mkdirSync(this.o.screenshotDir, { recursive: true });
    const path = join(this.o.screenshotDir, `${this.o.session}-${++this.shots}.png`);
    await this.call("screenshot", path);
    return { path, png: readFileSync(path) };
  }

  async close(): Promise<void> {
    await this.call("close").catch(() => {});
  }
}
