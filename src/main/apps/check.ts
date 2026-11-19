// The Creator agent's "test what you built": render an app off screen inside a small host page that plays the
// part of CubiQ's plugin host (theme, bridge relay), run its read-only calls for real, and report what broke. Calls
// that could change data are never run here; the user approves those when the app is open.

import { APP_THEME_DEFAULTS, APP_THEME_TOKENS } from "../../shared/apps";
import type { AppCallResult } from "../../shared/types";

// Not imported from serve.ts: serve.ts imports this file for the host page.
const APP_SCHEME = "cubiq-app";

/** The host page's URL: a fixed page with an empty sandboxed frame; the checker points the frame at the app. */
export const CHECK_HOST_URL = `${APP_SCHEME}://h/check.html`;
export const CHECK_WIDTH = 900;
export const CHECK_HEIGHT = 700;
/** Longest a check waits for the app to settle. */
export const CHECK_MAX_MS = 8000;
const MIN_AFTER_LOAD_MS = 600;
const QUIET_MS = 300;
const POLL_MS = 50;
const MAX_LOGS = 30;
const MAX_CALLS = 40;

/** The host page: frames the app, queues its bridge messages for main to drain, posts replies back. */
export function checkHostHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;display:block;width:100%;height:100%}</style></head><body><iframe id="f" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script>
(() => {
  const f = document.getElementById("f");
  const s = { queue: [], logs: [], loaded: false, ready: false, theme: null, droppedLogs: 0 };
  const post = (m) => f.contentWindow && f.contentWindow.postMessage(m, "*");
  window.addEventListener("message", (e) => {
    if (e.source !== f.contentWindow) return;
    const m = e.data;
    if (!m || m.cubiqApp !== 1 || typeof m.op !== "string") return;
    if (m.op === "ready") { s.ready = true; if (s.theme) post(s.theme); return; }
    if (m.op === "log") { if (s.logs.length < 60) s.logs.push({ level: m.level === "warn" ? "warn" : "error", message: String(m.message || "").slice(0, 600) }); else s.droppedLogs++; return; }
    if (s.queue.length < 200) s.queue.push(m);
  });
  f.addEventListener("load", () => { s.loaded = true; if (s.theme) post(s.theme); });
  window.__cq = {
    start(src, theme) { s.theme = theme; f.src = src; return true; },
    drain() { const out = { queue: s.queue, logs: s.logs, loaded: s.loaded, ready: s.ready, droppedLogs: s.droppedLogs }; s.queue = []; s.logs = []; s.droppedLogs = 0; return out; },
    reply(id, body) { post(Object.assign({ cubiqApp: 1, id }, body)); return true; },
  };
})();
</script></body></html>`;
}

export function checkHostCsp(): string {
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${APP_SCHEME}://a/; base-uri 'none'; form-action 'none'`;
}

/** The part of a hidden window the checker drives (injected, so tests use a fake). */
export interface CheckWindow {
  load(url: string): Promise<void>;
  /** Evaluate in the host page. */
  evaluate(script: string): Promise<unknown>;
  /** Evaluate inside the app's own frame (read-only probes), or null when the frame isn't there. */
  evaluateApp(script: string): Promise<unknown>;
  capture(width: number, height: number): Promise<Buffer>;
  destroy(): void;
}

export interface CheckOptions {
  scheme: "light" | "dark";
  screenshot: boolean;
  /** The size the app shows at (its placement's); default 900×700. */
  size?: { width: number; height: number };
  /** Below this much text (and no image, svg or canvas) the page counts as empty; a small widget needs less. Default 20. */
  minChars?: number;
}

export interface AppCheckDeps {
  createWindow(size: { width: number; height: number }): CheckWindow;
  call(key: string, server: string, tool: string, args: Record<string, unknown>): Promise<AppCallResult>;
  storeGet(key: string, name: string): unknown;
  storeSet(key: string, name: string, value: unknown): AppCallResult;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface AppCheckReport {
  ok: boolean;
  errors: { level: "error" | "warn"; message: string }[];
  calls: { call: string; status: "ok" | "error" | "not-run"; ms: number; error?: string }[];
  /** Nothing visible: no text worth reading and no image, svg or canvas. */
  empty: boolean;
  text: string;
  size: { width: number; height: number };
  /** The app never finished loading, or kept calling until the check's time ran out. */
  timedOut: boolean;
  png?: Buffer;
}

const PROBE = `(() => {
  const b = document.body;
  const text = b ? (b.innerText || "").replace(/\\s+/g, " ").trim() : "";
  return { text: text.slice(0, 600), chars: text.length, media: document.querySelectorAll("img,svg,canvas,video").length, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight };
})()`;

interface Drained {
  queue: Record<string, unknown>[];
  logs: { level: "error" | "warn"; message: string }[];
  loaded: boolean;
  ready: boolean;
  droppedLogs: number;
}

/** Checks run one at a time, each in a fresh hidden window that is destroyed afterwards. */
export class AppChecker {
  private queue: Promise<unknown> = Promise.resolve();
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private deps: AppCheckDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  check(key: string, src: string, opts: CheckOptions): Promise<AppCheckReport> {
    const run = this.queue.catch(() => {}).then(() => this.run(key, src, opts));
    this.queue = run;
    return run;
  }

  private async run(key: string, src: string, opts: CheckOptions): Promise<AppCheckReport> {
    const size = opts.size ?? { width: CHECK_WIDTH, height: CHECK_HEIGHT };
    const win = this.deps.createWindow(size);
    const errors: AppCheckReport["errors"] = [];
    const calls: AppCheckReport["calls"] = [];
    let dropped = 0;
    let pending = 0;
    let lastActivity = this.now();
    let loadedAt: number | null = null;
    const started = this.now();
    try {
      await win.load(CHECK_HOST_URL);
      const vars: Record<string, string> = {};
      for (const t of APP_THEME_TOKENS) vars[t] = APP_THEME_DEFAULTS[opts.scheme][t];
      const theme = { cubiqApp: 1, op: "theme", scheme: opts.scheme, vars };
      await win.evaluate(`window.__cq.start(${JSON.stringify(src)}, ${JSON.stringify(theme)})`);
      const reply = (id: unknown, body: { ok: true; result: unknown } | { ok: false; error: string }) => {
        if (typeof id !== "number") return Promise.resolve();
        return win.evaluate(`window.__cq.reply(${id}, ${JSON.stringify(body)})`).catch(() => {});
      };
      let timedOut = false;
      for (;;) {
        const d = (await win.evaluate("window.__cq.drain()")) as Drained;
        for (const l of d.logs) if (errors.length < MAX_LOGS) errors.push(l);
        dropped += d.droppedLogs;
        if (d.loaded && loadedAt === null) loadedAt = this.now();
        for (const m of d.queue) {
          lastActivity = this.now();
          const op = m.op;
          if (op === "call" && typeof m.server === "string" && typeof m.tool === "string") {
            const args = m.args && typeof m.args === "object" && !Array.isArray(m.args) ? (m.args as Record<string, unknown>) : {};
            const name = `${m.server}.${m.tool}`;
            const t0 = this.now();
            pending++;
            void this.deps
              .call(key, m.server, m.tool, args)
              .then(async (r) => {
                const ms = this.now() - t0;
                if (r.ok) {
                  if (calls.length < MAX_CALLS) calls.push({ call: name, status: "ok", ms });
                  await reply(m.id, r);
                } else if ("approval" in r) {
                  if (calls.length < MAX_CALLS) calls.push({ call: name, status: "not-run", ms, error: "can change data: the check doesn't run it (the user approves it when the app is open)" });
                  await reply(m.id, { ok: false, error: "The check doesn't run calls that can change data." });
                } else {
                  if (calls.length < MAX_CALLS) calls.push({ call: name, status: "error", ms, error: r.error.slice(0, 600) });
                  await reply(m.id, r);
                }
              })
              .catch(async (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                if (calls.length < MAX_CALLS) calls.push({ call: name, status: "error", ms: this.now() - t0, error: msg.slice(0, 600) });
                await reply(m.id, { ok: false, error: msg });
              })
              .finally(() => {
                pending--;
                lastActivity = this.now();
              });
          } else if (op === "store.get" && typeof m.key === "string") {
            await reply(m.id, { ok: true, result: this.deps.storeGet(key, m.key) });
          } else if (op === "store.set" && typeof m.key === "string") {
            const r = this.deps.storeSet(key, m.key, m.value);
            await reply(m.id, "approval" in r ? { ok: false, error: "Not allowed." } : r);
          }
        }
        const t = this.now();
        if (loadedAt !== null && t - loadedAt >= MIN_AFTER_LOAD_MS && pending === 0 && t - lastActivity >= QUIET_MS) break;
        if (t - started >= CHECK_MAX_MS) {
          timedOut = true;
          break;
        }
        await this.sleep(POLL_MS);
      }
      if (dropped) errors.push({ level: "warn", message: `${dropped} more console lines were dropped.` });
      const probe = ((await win.evaluateApp(PROBE).catch(() => null)) ?? null) as { text: string; chars: number; media: number; width: number; height: number } | null;
      const png = opts.screenshot ? await win.capture(size.width, size.height) : undefined;
      const empty = !probe || (probe.chars < (opts.minChars ?? 20) && probe.media === 0);
      const failed = errors.some((e) => e.level === "error") || calls.some((c) => c.status === "error");
      return {
        ok: !failed && !empty && !timedOut,
        errors,
        calls,
        empty,
        text: probe?.text ?? "",
        size: { width: probe?.width ?? 0, height: probe?.height ?? 0 },
        timedOut: timedOut || loadedAt === null,
        ...(png ? { png } : {}),
      };
    } finally {
      try {
        win.destroy();
      } catch {
        // Already gone.
      }
    }
  }
}
