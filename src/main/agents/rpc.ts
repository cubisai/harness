import { type ChildProcess, spawn } from "node:child_process";

/**
 * JSON-RPC 2.0 over an agent's stdio, one JSON message per line: the
 * transport of both the Agent Client Protocol and Codex's app-server.
 * Requests the agent sends us (permission prompts) go to `onRequest`;
 * notifications go to `onNotification`.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined };

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface RpcHandlers {
  onRequest(method: string, params: unknown): Promise<unknown>;
  onNotification(method: string, params: unknown): void;
  onExit?(code: number | null, stderrTail: string): void;
}

export class StdioRpc {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private stderrTail = "";
  private exited = false;

  private constructor(
    private child: ChildProcess,
    private handlers: RpcHandlers,
  ) {
    child.stdout!.setEncoding("utf-8");
    child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    child.stderr!.setEncoding("utf-8");
    child.stderr!.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    child.on("exit", (code) => this.onExit(code));
    child.on("error", (err) => {
      this.stderrTail += `\n${err.message}`;
      this.onExit(null);
    });
  }

  static spawn(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }, handlers: RpcHandlers): StdioRpc {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      // On Windows a bare name like "dsh" or "npx" is usually a .cmd shim,
      // which only the shell resolves; a full path runs directly (and may
      // contain spaces the shell would split).
      shell: process.platform === "win32" && !/[\\/]/.test(command),
      windowsHide: true,
    });
    return new StdioRpc(child, handlers);
  }

  get alive(): boolean {
    return !this.exited;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error(`The agent exited.${this.stderrHint()}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ jsonrpc: "2.0", id, method, params: params as Json });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.exited) this.send({ jsonrpc: "2.0", method, params: params as Json });
  }

  close(): void {
    if (this.exited) return;
    this.child.stdin?.end();
    this.child.kill();
  }

  private send(message: Record<string, Json | undefined>): void {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  private stderrHint(): string {
    const tail = this.stderrTail.trim().split("\n").slice(-6).join("\n");
    return tail ? `\n${tail}` : "";
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // agents sometimes log to stdout; ignore non-JSON lines
      }
      if (msg.method !== undefined && msg.id !== undefined) {
        void this.answer(msg.id, msg.method, msg.params);
      } else if (msg.method !== undefined) {
        this.handlers.onNotification(msg.method, msg.params);
      } else if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
        else p.resolve(msg.result);
      }
    }
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params);
      this.send({ jsonrpc: "2.0", id, result: (result ?? null) as Json });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603;
      this.send({ jsonrpc: "2.0", id, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private onExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    const err = new Error(`The agent exited (code ${code ?? "?"}).${this.stderrHint()}`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.handlers.onExit?.(code, this.stderrTail);
  }
}
