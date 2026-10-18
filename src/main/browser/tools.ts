import { z } from "zod";
import type { HarnessTool, ToolContext, ToolOutput } from "../agents/types";
import { asBackend, type BrowserBackend } from "./backend";
import type { BrowserController } from "./controller";

async function safely(fn: () => Promise<ToolOutput>): Promise<ToolOutput> {
  try {
    return await fn();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}

/** Open the pane if needed, then run the tool; a pane that won't open is reported, not thrown. */
function gated(browser: BrowserBackend, fn: () => Promise<ToolOutput>): Promise<ToolOutput> {
  return safely(async () => {
    try {
      await browser.ensureOpen();
    } catch (err) {
      throw new Error(`Couldn't open the browser pane: ${err instanceof Error ? err.message : String(err)}`);
    }
    return fn();
  });
}

/**
 * One browser target's ownership and order (P5.3). Actions that change the page run one at a time, in call order,
 * across every thread. The thread that acted last owns the target: while its turn is still running, another
 * thread's action is refused instead of silently acting on its page. Reads stay open to everyone.
 */
export class TargetLock {
  private chain: Promise<unknown> = Promise.resolve();
  private owner: string | null = null;

  constructor(private busy: (threadId: string) => boolean = () => false) {}

  /** Who drove the target last, if anyone. */
  get current(): string | null {
    return this.owner;
  }

  /** Run a mutation for `threadId` after every earlier one has finished. */
  run<T>(threadId: string | undefined, fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => {
      const owner = this.owner;
      if (threadId && owner && owner !== threadId && this.busy(owner)) {
        throw new Error("The browser pane is in use by another thread's running turn. Wait for it to finish, or carry on without the browser.");
      }
      if (threadId) this.owner = threadId;
      return fn();
    });
    // A failed mutation must not block the ones queued behind it.
    this.chain = next.catch(() => {});
    return next;
  }
}

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

/**
 * The browser pane's tools, named as HARNESS.md specifies. Snapshots are
 * text with element refs; screenshots are files, shown to the model only
 * when it asks to look. They are always offered, so the tool set never
 * changes mid-conversation; the first call opens the pane for the user.
 * A headless backend (agent-browser) runs the same tools in its own session.
 */
export function browserTools(target: BrowserBackend | BrowserController, opts: { busy?: (threadId: string) => boolean } = {}): HarnessTool[] {
  const browser = asBackend(target);
  const lock = new TargetLock(opts.busy);
  /** A page-changing tool: opened if needed, then queued on the target and owned by the calling thread. */
  const acting = (ctx: ToolContext | undefined, fn: () => Promise<ToolOutput>): Promise<ToolOutput> => gated(browser, () => lock.run(ctx?.threadId, fn));
  return [
    define({
      name: "browser_open",
      description:
        "Open a URL in the browser pane the user can see (a local dev server like localhost:3000, or any http(s) page), wait for it to load, and return a snapshot of the page. The pane opens automatically if it isn't already. Optionally emulate a mobile or tablet viewport first.",
      input: {
        url: z.string().describe("URL to open, e.g. http://localhost:5173/login"),
        device: z.enum(["mobile", "tablet", "desktop"]).optional().describe("Emulate a viewport before loading: mobile (390px), tablet (768px), or desktop (no emulation)"),
      },
      autoAllow: true,
      effect: "mutate",
      run: ({ url, device }, ctx) =>
        acting(ctx, async () => {
          await browser.open(url, device);
          return { text: await browser.snapshot() };
        }),
    }),
    define({
      name: "browser_snapshot",
      description:
        "Text snapshot of the current page in the browser pane: headings, text, and every link, button, and field with a ref like e3 for browser_click and browser_type. Refs change when the page changes; take a new snapshot after acting.",
      input: {},
      autoAllow: true,
      effect: "read",
      run: () => gated(browser, async () => ({ text: await browser.snapshot() })),
    }),
    define({
      name: "browser_click",
      description: "Click the element with this ref from the latest browser_snapshot, as a real mouse click.",
      input: { ref: z.string().describe("Element ref from browser_snapshot, e.g. e7") },
      autoAllow: true,
      effect: "mutate",
      run: ({ ref }, ctx) => acting(ctx, async () => ({ text: await browser.click(ref) })),
    }),
    define({
      name: "browser_type",
      description: "Type text into the field with this ref, replacing what's there. Set submit to press Enter afterwards.",
      input: {
        ref: z.string().describe("Field ref from browser_snapshot"),
        text: z.string(),
        submit: z.boolean().optional().describe("Press Enter after typing"),
      },
      autoAllow: true,
      effect: "mutate",
      run: ({ ref, text, submit }, ctx) => acting(ctx, async () => ({ text: await browser.type(ref, text, submit ?? false) })),
    }),
    define({
      name: "browser_eval",
      description:
        "Evaluate a JavaScript expression in the page and return its JSON value. For checks a snapshot can't show (localStorage, computed styles, app state).",
      input: { expression: z.string().describe("A JavaScript expression; may be async") },
      autoAllow: false,
      effect: "mutate",
      run: ({ expression }, ctx) => acting(ctx, async () => ({ text: await browser.evaluate(expression) })),
    }),
    define({
      name: "browser_logs",
      description:
        "Console errors and warnings, uncaught exceptions, and failed or 4xx/5xx network requests since the page loaded. Check after each step of a UI test.",
      input: { clear: z.boolean().optional().describe("Clear the log after reading") },
      autoAllow: true,
      effect: "read",
      run: ({ clear }) => gated(browser, async () => ({ text: await browser.logs(clear ?? false) })),
    }),
    define({
      name: "browser_screenshot",
      description:
        "Save a screenshot of the browser pane and return its file path, as evidence for a report. Set look to also see the image (costs far more tokens than a snapshot).",
      input: { look: z.boolean().optional().describe("Return the image to you as well as saving it") },
      autoAllow: true,
      effect: "read",
      run: ({ look }) =>
        gated(browser, async () => {
          const { path, png } = await browser.screenshot();
          return { text: `Saved ${path}`, imagePng: look ? png.toString("base64") : undefined };
        }),
    }),
  ];
}
