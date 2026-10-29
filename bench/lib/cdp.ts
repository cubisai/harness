// A minimal Chrome DevTools Protocol client: evaluate code in the app's
// renderer, where `window.unskilled` (the preload API) lives.

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  /** Waits for a renderer page with the preload API (the splash comes first), up to `timeoutMs`. */
  static async connect(port: number, timeoutMs = 180_000): Promise<Cdp> {
    const until = Date.now() + timeoutMs;
    let last = "no CDP endpoint";
    while (Date.now() < until) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
        for (const t of targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("devtools:"))) {
          const cdp = await Cdp.open(t.webSocketDebuggerUrl!);
          if (await cdp.evaluate<boolean>("typeof window.unskilled === 'object' && document.readyState === 'complete'").catch(() => false)) return cdp;
          cdp.close();
        }
        last = "no page with window.unskilled yet";
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`app on port ${port} not ready: ${last}`);
  }

  private static open(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error(`can't open ${url}`)));
    });
  }

  private send<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runs `expression` in the page; promises are awaited and the value comes back as JSON. */
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  /** `window.unskilled.<method>(...args)`; args must be JSON. */
  call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.evaluate<T>(`window.unskilled.${method}(...${JSON.stringify(args)})`);
  }

  close(): void {
    this.ws.close();
  }
}
