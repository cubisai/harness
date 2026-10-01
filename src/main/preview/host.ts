import { promises as fs } from "node:fs";
import type { OfficePreview } from "./office";

/** The slice of Electron's utility process this host needs; testable via a fake. */
export type WorkerLike = {
  postMessage(v: unknown): void;
  on(e: "message", f: (v: unknown) => void): void;
  on(e: "exit", f: (code: number) => void): void;
  kill(): boolean;
};

export type PreviewResult = { ok: true; result: OfficePreview } | { ok: false; error: string };

/** Refuse files bigger than this before they ever reach the worker. */
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
/** How long one request may run before the worker is killed and forked afresh. */
export const PREVIEW_TIMEOUT_MS = 10_000;
/** Successful previews kept per path; the oldest is dropped past this. */
const MAX_CACHE_ENTRIES = 20;

type StatInfo = { mtimeMs: number; size: number };

type Pending = {
  path: string;
  info: StatInfo;
  resolve: (value: PreviewResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Owns the single utilityProcess that renders office previews. It lazily forks,
 * matches answers by id, caches by path+mtime, times requests out, and turns a
 * worker exit into errors for whatever was in flight — never a rejection.
 */
export class PreviewHost {
  private readonly fork: () => WorkerLike;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly stat: (path: string) => Promise<StatInfo>;
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly cache = new Map<string, StatInfo & { result: OfficePreview }>();

  constructor(fork: () => WorkerLike, opts?: { timeoutMs?: number; maxBytes?: number; stat?: (path: string) => Promise<StatInfo> }) {
    this.fork = fork;
    this.timeoutMs = opts?.timeoutMs ?? PREVIEW_TIMEOUT_MS;
    this.maxBytes = opts?.maxBytes ?? PREVIEW_MAX_BYTES;
    this.stat = opts?.stat ?? ((path) => fs.stat(path));
  }

  /** Render one file, answering with an error rather than rejecting. */
  async preview(path: string): Promise<PreviewResult> {
    try {
      const info = await this.stat(path);
      if (info.size > this.maxBytes) return { ok: false, error: `File is larger than ${Math.round(this.maxBytes / (1024 * 1024))} MB` };

      const cached = this.cache.get(path);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return { ok: true, result: cached.result };

      const worker = this.ensureWorker();
      const id = this.nextId++;
      return await new Promise<PreviewResult>((resolve) => {
        const timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          resolve({ ok: false, error: "Preview timed out" });
          this.killWorker();
        }, this.timeoutMs);
        this.pending.set(id, { path, info, resolve, timer });
        worker.postMessage({ id, path, maxBytes: this.maxBytes });
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Kill the worker and settle everything in flight. */
  dispose(): void {
    this.failPending("Preview worker stopped");
    this.killWorker();
  }

  private ensureWorker(): WorkerLike {
    if (!this.worker) {
      const worker = this.fork();
      worker.on("message", (value) => this.onMessage(value));
      worker.on("exit", () => this.onExit(worker));
      this.worker = worker;
    }
    return this.worker;
  }

  private onMessage(value: unknown): void {
    const message = value as { id?: unknown; ok?: unknown; result?: OfficePreview; error?: unknown };
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.ok === true && message.result !== undefined) {
      this.remember(entry.path, entry.info, message.result);
      entry.resolve({ ok: true, result: message.result });
    } else {
      entry.resolve({ ok: false, error: typeof message.error === "string" ? message.error : "Preview failed" });
    }
  }

  private onExit(worker: WorkerLike): void {
    // A stale worker's exit must not disturb its replacement's requests.
    if (this.worker !== worker) return;
    this.worker = null;
    this.failPending("Preview worker stopped");
  }

  private failPending(error: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error });
    }
    this.pending.clear();
  }

  private remember(path: string, info: StatInfo, result: OfficePreview): void {
    this.cache.delete(path);
    this.cache.set(path, { ...info, result });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private killWorker(): void {
    const worker = this.worker;
    this.worker = null;
    try {
      worker?.kill();
    } catch {
      // Killing an already-dead process is not a failure worth surfacing.
    }
  }
}

/** Build a fork callback that starts the worker through Electron's utilityProcess. */
export function utilityFork(
  up: { fork(modulePath: string, args?: string[], opts?: { serviceName?: string }): WorkerLike },
  workerPath: string,
): () => WorkerLike {
  return () => up.fork(workerPath, [], { serviceName: "CubiQ preview" });
}
