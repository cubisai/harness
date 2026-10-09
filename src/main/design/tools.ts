import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessTool, ToolOutput } from "../agents/types";
import { resolveInside } from "../artifacts";
import { formatLint, type LintResult } from "./lint";
import type { Shot } from "./shooter";

export const DESIGN_SCREENSHOT_TOOL = "design_screenshot";
export const DESIGN_LINT_TOOL = "design_lint";
export const DESIGN_CRITIQUE_SAVE_TOOL = "design_critique_save";

/** The longest critique the save tool keeps. */
export const CRITIQUE_MAX_CHARS = 32_000;

/** What the design tools need from the app; injected so they stay testable. */
export interface DesignToolDeps {
  /** The design thread's folder (absolute), or null when it has none. */
  root(threadId: string): string | null;
  /** The folder as the agent knows it (`designs/<id8>`), for messages. */
  folder(threadId: string): string;
  /** The `cubiq-design://` URL of a file in the design folder. */
  url(threadId: string, rel: string): string;
  screenshot(url: string, opts: { width: number; height: number; fullPage: boolean }): Promise<Shot>;
  evaluate(url: string, width: number, height: number, script: string): Promise<unknown>;
  /** The lint page script (lintScript(selectorFor)). */
  lintScript: string;
  /** Save the next critique version; null when the text is unchanged. */
  saveCritique(threadId: string, markdown: string): { version: number } | null;
}

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

const clamp = (n: number | undefined, lo: number, hi: number, dflt: number): number =>
  n === undefined || !Number.isFinite(n) ? dflt : Math.min(hi, Math.max(lo, Math.round(n)));

/** A page in the design folder the tools may render: inside it, an existing file, html or svg. */
function pageOf(deps: DesignToolDeps, threadId: string, path: string | undefined): { rel: string } | ToolOutput {
  const root = deps.root(threadId);
  if (!root) return { text: "This thread has no design folder.", isError: true };
  const want = (path ?? "index.html").trim().replace(/\\/g, "/").replace(new RegExp(`^(\\./)?${deps.folder(threadId)}/`), "");
  const rel = resolveInside(root, want || "index.html");
  if (!rel) return { text: `${want} is outside ${deps.folder(threadId)}/.`, isError: true };
  let isFile = false;
  try {
    isFile = statSync(join(root, rel)).isFile();
  } catch {
    // Not there yet.
  }
  if (!isFile) return { text: `${deps.folder(threadId)}/${rel} doesn't exist yet. Build the page first.`, isError: true };
  if (!/\.(html?|svg)$/i.test(rel)) return { text: `${rel} isn't a page (html or svg).`, isError: true };
  return { rel };
}

const failed = (what: string, err: unknown): ToolOutput => ({ text: `${what} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true });

/**
 * The design thread's evaluator tools, bound to one thread: screenshot and
 * lint a page off screen, and save the critique as the thread's Critique
 * artifact. Offered only to design threads.
 */
export function designTools(deps: DesignToolDeps, threadId: string): HarnessTool[] {
  return [
    define({
      name: DESIGN_SCREENSHOT_TOOL,
      description:
        "Render a page of this design off screen and return a PNG, to check your work visually. Use width 390 for mobile, 1440 for desktop.",
      input: {
        path: z.string().optional().describe("Page inside the design folder; default index.html"),
        width: z.number().optional().describe("Viewport width in CSS px, 320-2560; default 1440"),
        height: z.number().optional().describe("Viewport height in CSS px, 320-4000; default 900"),
        fullPage: z.boolean().optional().describe("Capture the whole scroll height (up to 4000 px); default false"),
      },
      autoAllow: true,
      run: async (args) => {
        const page = pageOf(deps, threadId, args.path);
        if (!("rel" in page)) return page;
        const width = clamp(args.width, 320, 2560, 1440);
        const height = clamp(args.height, 320, 4000, 900);
        try {
          const shot = await deps.screenshot(deps.url(threadId, page.rel), { width, height, fullPage: args.fullPage === true });
          const note = shot.cut ? " (full page, cut at 4000 px)" : args.fullPage ? " (full page)" : "";
          return { text: `${deps.folder(threadId)}/${page.rel} at ${shot.width}×${shot.height}${note}.`, imagePng: shot.png.toString("base64") };
        } catch (err) {
          return failed("Screenshot", err);
        }
      },
    }),
    define({
      name: DESIGN_LINT_TOOL,
      description:
        "Check a page of this design against the design rules: text contrast (4.5:1, 3:1 large), tap targets (44×44), spacing on the 4px grid, and colors that aren't --color-* tokens. Returns findings with CSS selectors, worst first.",
      input: {
        path: z.string().optional().describe("Page inside the design folder; default index.html"),
        width: z.number().optional().describe("Viewport width in CSS px, 320-2560; default 1440"),
      },
      autoAllow: true,
      run: async (args) => {
        const page = pageOf(deps, threadId, args.path);
        if (!("rel" in page)) return page;
        const width = clamp(args.width, 320, 2560, 1440);
        try {
          const raw = await deps.evaluate(deps.url(threadId, page.rel), width, 900, deps.lintScript);
          const result = JSON.parse(String(raw)) as LintResult;
          return { text: `${deps.folder(threadId)}/${page.rel} at ${width}px\n${formatLint(result)}` };
        } catch (err) {
          return failed("Lint", err);
        }
      },
    }),
    define({
      name: DESIGN_CRITIQUE_SAVE_TOOL,
      description:
        "Save your design critique (markdown) as the next version of this thread's Critique, which the user sees in the side panel. Save once per critique round.",
      input: {
        markdown: z.string().describe("The full critique in markdown"),
      },
      autoAllow: true,
      run: async (args) => {
        const text = args.markdown.trim();
        if (!text) return { text: "The critique is empty.", isError: true };
        if (text.length > CRITIQUE_MAX_CHARS) return { text: `The critique is too long (max ${CRITIQUE_MAX_CHARS} characters).`, isError: true };
        try {
          const saved = deps.saveCritique(threadId, `${text}\n`);
          return { text: saved ? `Saved as Critique v${saved.version}.` : "Unchanged from the last critique; no new version." };
        } catch (err) {
          return failed("Saving the critique", err);
        }
      },
    }),
  ];
}
