import { z } from "zod";
import type { HarnessTool, ToolOutput } from "../agents/types";
import type { BrowserController } from "./controller";

async function safely(fn: () => Promise<ToolOutput>): Promise<ToolOutput> {
  try {
    return await fn();
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}

/** Refuse, without touching the browser, until the user opens the pane. */
function gated(browser: BrowserController, fn: () => Promise<ToolOutput>): Promise<ToolOutput> {
  if (!browser.enabled) return Promise.resolve({ text: "Browser pane not open", isError: true });
  return safely(fn);
}

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

/**
 * The browser pane's tools, named as HARNESS.md specifies. Snapshots are
 * text with element refs; screenshots are files, shown to the model only
 * when it asks to look. They are always offered, so the tool set never
 * changes mid-conversation; until the user opens the Browser tab they
 * answer "Browser pane not open".
 */
export function browserTools(browser: BrowserController): HarnessTool[] {
  return [
    define({
      name: "browser_open",
      description:
        "Open a URL in the browser pane the user can see (a local dev server like localhost:3000, or any http(s) page), wait for it to load, and return a snapshot of the page. Optionally emulate a mobile or tablet viewport first.",
      input: {
        url: z.string().describe("URL to open, e.g. http://localhost:5173/login"),
        device: z.enum(["mobile", "tablet", "desktop"]).optional().describe("Emulate a viewport before loading: mobile (390px), tablet (768px), or desktop (no emulation)"),
      },
      autoAllow: true,
      run: ({ url, device }) =>
        gated(browser, async () => {
          browser.assertOpenAllowed();
          if (device) await browser.setDevice(device);
          await browser.page(url);
          browser.announce("open", undefined);
          return { text: await browser.snapshot() };
        }),
    }),
    define({
      name: "browser_snapshot",
      description:
        "Text snapshot of the current page in the browser pane: headings, text, and every link, button, and field with a ref like e3 for browser_click and browser_type. Refs change when the page changes; take a new snapshot after acting.",
      input: {},
      autoAllow: true,
      run: () => gated(browser, async () => ({ text: await browser.snapshot() })),
    }),
    define({
      name: "browser_click",
      description: "Click the element with this ref from the latest browser_snapshot, as a real mouse click.",
      input: { ref: z.string().describe("Element ref from browser_snapshot, e.g. e7") },
      autoAllow: true,
      run: ({ ref }) => gated(browser, async () => ({ text: await browser.click(ref) })),
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
      run: ({ ref, text, submit }) => gated(browser, async () => ({ text: await browser.type(ref, text, submit ?? false) })),
    }),
    define({
      name: "browser_eval",
      description:
        "Evaluate a JavaScript expression in the page and return its JSON value. For checks a snapshot can't show (localStorage, computed styles, app state).",
      input: { expression: z.string().describe("A JavaScript expression; may be async") },
      autoAllow: false,
      run: ({ expression }) => gated(browser, async () => ({ text: await browser.evaluateForAgent(expression) })),
    }),
    define({
      name: "browser_logs",
      description:
        "Console errors and warnings, uncaught exceptions, and failed or 4xx/5xx network requests since the page loaded. Check after each step of a UI test.",
      input: { clear: z.boolean().optional().describe("Clear the log after reading") },
      autoAllow: true,
      run: ({ clear }) => gated(browser, async () => ({ text: await browser.readLogs(clear ?? false) })),
    }),
    define({
      name: "browser_screenshot",
      description:
        "Save a screenshot of the browser pane and return its file path, as evidence for a report. Set look to also see the image (costs far more tokens than a snapshot).",
      input: { look: z.boolean().optional().describe("Return the image to you as well as saving it") },
      autoAllow: true,
      run: ({ look }) =>
        gated(browser, async () => {
          const { path, png } = await browser.screenshot();
          return { text: `Saved ${path}`, imagePng: look ? png.toString("base64") : undefined };
        }),
    }),
  ];
}
