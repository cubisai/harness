import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { IPty } from "node-pty";
import { onPath } from "./agents/registry";

/** The user's shell: $SHELL on macOS/Linux; PowerShell 7, then Windows PowerShell, then cmd on Windows. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): { file: string; args: string[] } {
  if (platform === "win32") {
    if (onPath("pwsh", env, platform)) return { file: "pwsh.exe", args: ["-NoLogo"] };
    if (onPath("powershell", env, platform)) return { file: "powershell.exe", args: ["-NoLogo"] };
    return { file: env.ComSpec ?? "cmd.exe", args: [] };
  }
  const shell = env.SHELL && existsSync(env.SHELL) ? env.SHELL : existsSync("/bin/zsh") && platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  return { file: shell, args: ["-l"] };
}

export interface TerminalEvents {
  data(id: string, data: string): void;
  exit(id: string, code: number): void;
}

/**
 * Real terminals (node-pty) for the Terminal tab, one per project, keyed by
 * the project id. node-pty is loaded on first use, so the rest of the app
 * starts even where it isn't available.
 */
export class TerminalManager {
  private terms = new Map<string, IPty>();
  private opening = new Map<string, Promise<void>>();

  constructor(private events: TerminalEvents) {}

  async open(id: string, cwd: string | null, cols: number, rows: number): Promise<void> {
    if (this.terms.has(id)) {
      this.resize(id, cols, rows);
      return;
    }
    const existing = this.opening.get(id);
    if (existing) { await existing; this.resize(id, cols, rows); return; }
    const opening = import("node-pty").then((pty) => {
      if (this.opening.get(id) === opening) this.spawn(pty, id, cwd, cols, rows);
    });
    this.opening.set(id, opening);
    try { await opening; } finally { if (this.opening.get(id) === opening) this.opening.delete(id); }
  }

  private spawn(pty: typeof import("node-pty"), id: string, cwd: string | null, cols: number, rows: number): void {
    const shell = defaultShell();
    const term = pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: Math.max(2, cols),
      rows: Math.max(2, rows),
      cwd: cwd && existsSync(cwd) ? cwd : homedir(),
      env: { ...process.env, TERM_PROGRAM: "CubiQ" } as Record<string, string>,
    });
    this.terms.set(id, term);
    term.onData((d) => { if (this.terms.get(id) === term) this.events.data(id, d); });
    term.onExit(({ exitCode }) => {
      if (this.terms.get(id) !== term) return;
      this.terms.delete(id);
      this.events.exit(id, exitCode);
    });
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.terms.get(id)?.resize(Math.max(2, cols), Math.max(2, rows));
    } catch {
      // resizing an exiting pty throws; nothing to do
    }
  }

  close(id: string): void {
    this.opening.delete(id);
    this.terms.get(id)?.kill();
    this.terms.delete(id);
  }

  dispose(): void {
    this.opening.clear();
    for (const t of this.terms.values()) t.kill();
    this.terms.clear();
  }
}
