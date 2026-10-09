import { DESIGN_SCHEME } from "./serve";

/** The part of a hidden BrowserWindow the shooter drives; injected so it stays testable. */
export interface ShotWindow {
  setContentSize(width: number, height: number): void;
  load(url: string): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  /** A PNG of the visible area, scaled to CSS pixels. */
  capture(width: number, height: number): Promise<Buffer>;
  pdf(): Promise<Buffer>;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface ShotOptions {
  width: number;
  height: number;
  /** Grow the window to the page's scroll height (capped at SHOT_MAX_HEIGHT) before capturing. */
  fullPage?: boolean;
}

export interface Shot {
  png: Buffer;
  width: number;
  height: number;
  /** The page was taller than SHOT_MAX_HEIGHT and the image stops there. */
  cut: boolean;
}

/** The tallest image a screenshot returns. */
export const SHOT_MAX_HEIGHT = 4000;
/** How long an unused shooter window lives. */
export const SHOOTER_IDLE_MS = 60_000;

/** Fonts loaded, then two frames, so the capture shows the settled page; gives up after 3 s. */
const SETTLE = `Promise.race([
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))),
  new Promise((r) => setTimeout(r, 3000)),
]).then(() => true)`;

/** Two frames after a resize. */
const FRAMES = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`;

const SCROLL_HEIGHT = `Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`;

/**
 * Renders design pages off screen for the design tools and Export: one hidden
 * window, made on first use, reused for queued jobs (one at a time), destroyed
 * after a minute unused. It loads only `cubiq-design://` URLs.
 */
export class Shooter {
  private win: ShotWindow | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly createWindow: () => ShotWindow,
    private readonly idleMs = SHOOTER_IDLE_MS,
  ) {}

  /** A PNG of the page at `url`. */
  screenshot(url: string, opts: ShotOptions): Promise<Shot> {
    return this.job(url, opts.width, opts.height, async (win) => {
      if (!opts.fullPage) return { png: await win.capture(opts.width, opts.height), width: opts.width, height: opts.height, cut: false };
      const full = Math.max(1, Math.round(Number(await win.evaluate(SCROLL_HEIGHT)) || opts.height));
      const height = Math.min(full, SHOT_MAX_HEIGHT);
      if (height !== opts.height) {
        win.setContentSize(opts.width, height);
        await win.evaluate(FRAMES);
      }
      return { png: await win.capture(opts.width, height), width: opts.width, height, cut: full > SHOT_MAX_HEIGHT };
    });
  }

  /** Run `script` (an expression) in the page at `url`, laid out `width` wide, and return its value. */
  evaluate(url: string, width: number, height: number, script: string): Promise<unknown> {
    return this.job(url, width, height, (win) => win.evaluate(script));
  }

  /** The page at `url` as a PDF (the page's own @page size wins, so a deck prints one slide per page). */
  pdf(url: string, width: number): Promise<Buffer> {
    return this.job(url, width, 900, (win) => win.pdf());
  }

  /** Destroy the window now (app quit); later jobs are refused. */
  close(): void {
    this.closed = true;
    this.dispose();
  }

  private job<T>(url: string, width: number, height: number, work: (win: ShotWindow) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.closed) throw new Error("The design renderer is closed.");
      if (!url.startsWith(`${DESIGN_SCHEME}://`)) throw new Error("Only design pages can be rendered.");
      if (this.idle) clearTimeout(this.idle);
      this.idle = null;
      try {
        const win = this.window();
        win.setContentSize(width, height);
        await win.load(url);
        await win.evaluate(SETTLE);
        return await work(win);
      } catch (err) {
        // A window that failed mid-job may be in any state: start the next job on a fresh one.
        this.dispose();
        throw err;
      } finally {
        if (!this.closed && this.win) this.idle = setTimeout(() => this.dispose(), this.idleMs);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private window(): ShotWindow {
    if (!this.win || this.win.isDestroyed()) this.win = this.createWindow();
    return this.win;
  }

  private dispose(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
