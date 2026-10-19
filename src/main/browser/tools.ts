import { z } from "zod";
import type { HarnessTool, ToolContext, ToolOutput } from "../agents/types";
import { asBackend, WAIT_MAX_MS, type BrowserBackend, type WaitFor } from "./backend";
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

/** The readiness condition browser_open, browser_click and browser_type accept (P5.4). */
const waitFor = z
  .object({
    url: z.string().optional().describe("The URL contains this, e.g. /dashboard"),
    selector: z.string().optional().describe("A CSS selector that must match a visible element"),
    text: z.string().optional().describe("Text that must appear on the page"),
    timeout_ms: z.number().int().positive().max(WAIT_MAX_MS).optional().describe("Give up after this long (default 5000)"),
  })
  .optional()
  .describe("Wait until all given conditions hold before returning, instead of a fixed short pause. Use it when the action starts a navigation or loads content.");

type WaitArg = z.infer<typeof waitFor>;

/** The tool argument as the backend's WaitFor; undefined when absent. */
function toWait(w: WaitArg): WaitFor | undefined {
  if (!w) return undefined;
  return { ...(w.url ? { url: w.url } : {}), ...(w.selector ? { selector: w.selector } : {}), ...(w.text ? { text: w.text } : {}), ...(w.timeout_ms ? { timeoutMs: w.timeout_ms } : {}) };
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
        wait_for: waitFor,
      },
      autoAllow: true,
      effect: "mutate",
      run: ({ url, device, wait_for }, ctx) =>
        acting(ctx, async () => {
          const note = await browser.open(url, device, toWait(wait_for));
          const snap = await browser.snapshot();
          return { text: note ? `${note}\n\n${snap}` : snap };
        }),
    }),
    define({
      name: "browser_snapshot",
      description:
        "Text snapshot of the current page in the browser pane: headings, text, and every link, button, and field with a ref like e3 for browser_click and browser_type. An element keeps its ref while it stays on the page; take a new snapshot after the page changes. Narrow it with selector or interactive to save tokens.",
      input: {
        selector: z.string().optional().describe("Only the part of the page inside this CSS selector, e.g. main or #checkout"),
        interactive: z.boolean().optional().describe("Only links, buttons and fields (no headings or text)"),
      },
      autoAllow: true,
      effect: "read",
      run: ({ selector, interactive }) =>
        gated(browser, async () => ({ text: await browser.snapshot(selector || interactive ? { ...(selector ? { selector } : {}), ...(interactive ? { interactive } : {}) } : undefined) })),
    }),
    define({
      name: "browser_click",
      description: "Click the element with this ref from the latest browser_snapshot, as a real mouse click.",
      input: { ref: z.string().describe("Element ref from browser_snapshot, e.g. e7"), wait_for: waitFor },
      autoAllow: true,
      effect: "mutate",
      run: ({ ref, wait_for }, ctx) => acting(ctx, async () => ({ text: await browser.click(ref, toWait(wait_for)) })),
    }),
    define({
      name: "browser_type",
      description: "Type text into the field with this ref, replacing what's there. Set submit to press Enter afterwards.",
      input: {
        ref: z.string().describe("Field ref from browser_snapshot"),
        text: z.string(),
        submit: z.boolean().optional().describe("Press Enter after typing"),
        wait_for: waitFor,
      },
      autoAllow: true,
      effect: "mutate",
      run: ({ ref, text, submit, wait_for }, ctx) => acting(ctx, async () => ({ text: await browser.type(ref, text, submit ?? false, toWait(wait_for)) })),
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
      input: {
        clear: z.boolean().optional().describe("Clear the log after reading"),
        new_only: z.boolean().optional().describe("Only what was logged since your last browser_logs call"),
      },
      autoAllow: true,
      effect: "read",
      run: ({ clear, new_only }) => gated(browser, async () => ({ text: await browser.logs(clear ?? false, new_only ?? false) })),
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
