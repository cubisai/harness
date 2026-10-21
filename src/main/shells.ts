// Background shells: commands an agent starts and leaves running (a dev server,
// a watcher, `docker compose up`). Each shell's output is kept in a ring buffer
// so the agent can read what accumulated, and stopping one kills its whole
// process tree, not just the shell the command was started with.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";
import type { BackgroundShell } from "../shared/types";
import { shellFor } from "./harness/tools/bash";

/** What a shell is doing: running, exited on its own, or stopped by us. */
export type ShellStatus = BackgroundShell["status"];

/** A background shell as callers see it (a copy: mutating it changes nothing). Its id is "sh-" + six hex characters. */
export type ShellInfo = BackgroundShell;

/** One read of a shell's output. */
export interface ShellOutput {
  info: ShellInfo;
  text: string;
  /** The absolute offset this read ended at; pass it back as `since` next time. */
  next: number;
  /** True when `since` pointed before the buffered part, so older output is gone. */
  dropped: boolean;
}

/** Raised when a thread or the app already runs as many shells as it may. */
export class ShellLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellLimitError";
  }
}

/** Tuning for a ShellManager; every field has a default. */
export interface ShellManagerOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Running shells one thread may have (default 4). */
  maxPerThread?: number;
  /** Running shells the app may have (default 12). */
  maxTotal?: number;
  /** Characters of output kept per shell (default 256 * 1024). */
  bufferChars?: number;
  /** How long exited/stopped shells stay listed (default one hour). */
  keepExitedMs?: number;
  /** Called on every start, exit and stop, with a snapshot of the shell. */
  onChange?(info: ShellInfo): void;
  /** Test seam for time; default Date.now. */
  now?(): number;
}

interface Entry {
  info: ShellInfo;
  /** The last bufferChars characters of output. */
  text: string;
  /** Characters ever appended, so offsets survive truncation. */
  written: number;
  settled: boolean;
  seq: number;
  killTimer: ReturnType<typeof setTimeout> | null;
  exited: Promise<void>;
  resolveExited: () => void;
}

/** The shell's name: the one given, or the command's first line cut to 40 characters. */
function defaultName(command: string): string {
  const first = command.trim().split(/\r?\n/, 1)[0]?.trim() || "shell";
  return first.length > 40 ? first.slice(0, 40) : first;
}

/** The last `count` lines of a buffer; a truncated first line counts as one. */
function lastLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-Math.max(1, Math.trunc(count))).join("\n");
}

/**
 * Starts, reads and stops background shells. One manager serves the whole app;
 * shells are grouped by the thread that started them so tools stay thread-local.
 */
export class ShellManager {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxPerThread: number;
  private readonly maxTotal: number;
  private readonly bufferChars: number;
  private readonly keepExitedMs: number;
  private readonly onChange?: (info: ShellInfo) => void;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private seq = 0;
  private disposed = false;

  constructor(options: ShellManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.maxPerThread = options.maxPerThread ?? 4;
    this.maxTotal = options.maxTotal ?? 12;
    this.bufferChars = options.bufferChars ?? 256 * 1024;
    this.keepExitedMs = options.keepExitedMs ?? 3_600_000;
    this.onChange = options.onChange;
    this.now = options.now ?? Date.now;
  }

  /** Start a command in the background and return the shell's id and status at once. */
  start(threadId: string, cwd: string, command: string, name?: string): ShellInfo {
    this.prune();
    const running = [...this.entries.values()].filter((e) => e.info.status === "running");
    if (running.filter((e) => e.info.threadId === threadId).length >= this.maxPerThread) {
      throw new ShellLimitError(`This thread already runs ${this.maxPerThread} background shells. Stop one first.`);
    }
    if (running.length >= this.maxTotal) throw new ShellLimitError(`${this.maxTotal} background shells are running. Stop one first.`);

    let id = "";
    do id = `sh-${randomBytes(3).toString("hex")}`;
    while (this.entries.has(id));

    const shell = shellFor(this.platform, this.env);
    const child = spawn(shell.file, shell.args(command), {
      cwd,
      env: this.env,
      detached: this.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolveExited = (): void => {};
    const exited = new Promise<void>((settle) => {
      resolveExited = settle;
    });
    const entry: Entry = {
      info: {
        id,
        threadId,
        name: name?.trim() || defaultName(command),
        command,
        cwd,
        status: "running",
        exitCode: null,
        startedAt: this.now(),
        endedAt: null,
        pid: child.pid ?? null,
      },
      text: "",
      written: 0,
      settled: false,
      seq: ++this.seq,
      killTimer: null,
      exited,
      resolveExited,
    };
    this.entries.set(id, entry);

    const append = (chunk: string): void => {
      entry.written += chunk.length;
      entry.text += chunk;
      if (entry.text.length > this.bufferChars) entry.text = entry.text.slice(-this.bufferChars);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      append(`Failed to start ${shell.name}: ${err.message}\n`);
      this.settle(entry, null);
    });
    child.on("exit", (code) => this.settle(entry, code));
    child.on("close", (code) => this.settle(entry, code));

    this.notify(entry);
    return this.snapshot(entry.info);
  }

  /** Read a shell's output from an absolute offset, or its last lines; null when unknown. */
  output(id: string, opts: { since?: number; tail?: number } = {}): ShellOutput | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const bufferStart = entry.written - entry.text.length;
    let text: string;
    let dropped = false;
    if (opts.since !== undefined) {
      const since = Math.max(0, Math.trunc(opts.since));
      if (since < bufferStart) {
        dropped = true;
        text = entry.text;
      } else {
        text = entry.text.slice(since - bufferStart);
      }
    } else {
      text = lastLines(entry.text, opts.tail ?? 100);
    }
    return { info: this.snapshot(entry.info), text, next: entry.written, dropped };
  }

  /** One shell by id, or null when it is unknown or forgotten. */
  get(id: string): ShellInfo | null {
    const entry = this.entries.get(id);
    return entry ? this.snapshot(entry.info) : null;
  }

  /** The thread's shells (or every shell), newest first. */
  list(threadId?: string): ShellInfo[] {
    this.prune();
    return [...this.entries.values()]
      .filter((e) => threadId === undefined || e.info.threadId === threadId)
      .sort((a, b) => b.seq - a.seq)
      .map((e) => this.snapshot(e.info));
  }

  /** Stop a shell and wait for it to exit, for at most three seconds. */
  async stop(id: string): Promise<ShellInfo | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.info.status !== "running") return this.snapshot(entry.info);
    entry.info.status = "stopped";
    this.killTree(entry);
    await this.waitForExit(entry, 3000);
    if (!entry.settled) {
      entry.settled = true;
      if (entry.killTimer) {
        clearTimeout(entry.killTimer);
        entry.killTimer = null;
      }
      entry.info.exitCode = null;
      entry.info.endedAt = this.now();
      entry.resolveExited();
      this.notify(entry);
    }
    return this.snapshot(entry.info);
  }

  /** Stop every running shell of one thread. */
  async stopThread(threadId: string): Promise<void> {
    const ids = [...this.entries.values()].filter((e) => e.info.threadId === threadId && e.info.status === "running").map((e) => e.info.id);
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /** Stop the shells whose working folder is `dir` or inside it (a removed worktree's). */
  async stopUnder(dir: string): Promise<void> {
    const base = resolve(dir);
    const prefix = base.endsWith(sep) ? base : base + sep;
    const ids = [...this.entries.values()]
      .filter((e) => e.info.status === "running")
      .filter((e) => {
        const cwd = resolve(e.info.cwd);
        return cwd === base || cwd.startsWith(prefix);
      })
      .map((e) => e.info.id);
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /** App quit: kill every running tree synchronously, best effort. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.info.status !== "running") continue;
      entry.settled = true;
      if (entry.killTimer) clearTimeout(entry.killTimer);
      entry.resolveExited();
      const pid = entry.info.pid;
      if (pid === null) continue;
      if (this.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        continue;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    this.entries.clear();
  }

  /** Forget shells that ended more than keepExitedMs ago. */
  private prune(): void {
    const cutoff = this.now() - this.keepExitedMs;
    for (const [id, entry] of this.entries) {
      if (entry.info.status === "running") continue;
      if ((entry.info.endedAt ?? entry.info.startedAt) < cutoff) this.entries.delete(id);
    }
  }

  /** Finish a shell once, whether it exited on its own or after a stop. */
  private settle(entry: Entry, code: number | null): void {
    if (entry.settled || this.disposed) return;
    entry.settled = true;
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = null;
    }
    // A stop already set "stopped"; an exit of its own is "exited".
    if (entry.info.status === "running") entry.info.status = "exited";
    entry.info.exitCode = code;
    entry.info.endedAt = this.now();
    entry.resolveExited();
    this.notify(entry);
  }

  /** Kill the whole tree, like the Bash tool: SIGTERM, then SIGKILL two seconds later. */
  private killTree(entry: Entry): void {
    const pid = entry.info.pid;
    if (pid === null || entry.settled) return;
    if (this.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    entry.killTimer = setTimeout(() => {
      entry.killTimer = null;
      if (entry.settled) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, 2000);
    entry.killTimer.unref();
  }

  /** Wait for the shell's exit, but never longer than `ms`. */
  private waitForExit(entry: Entry, ms: number): Promise<void> {
    return new Promise<void>((done) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      void entry.exited.then(() => {
        clearTimeout(timer);
        done();
      });
    });
  }

  private notify(entry: Entry): void {
    this.onChange?.(this.snapshot(entry.info));
  }

  private snapshot(info: ShellInfo): ShellInfo {
    return { ...info };
  }
}
