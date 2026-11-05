import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessTool, ToolOutput } from "../agents/types";
import { resolveInside } from "../artifacts";
import { styleAllows, withoutAllowed } from "./autolint";
import { formatLint, type LintResult } from "./lint";
import type { Shot } from "./shooter";
import { MODES, SURFACES, type DesignDirection } from "../../shared/direction";

export const DESIGN_SCREENSHOT_TOOL = "design_screenshot";
export const DESIGN_LINT_TOOL = "design_lint";
export const DESIGN_CRITIQUE_SAVE_TOOL = "design_critique_save";
export const DESIGN_DIRECTION_TOOL = "design_set_direction";
export const DESIGN_KIT_INSPECT_TOOL = "design_kit_inspect";
export const DESIGN_KIT_SAVE_TOOL = "design_kit_save";
export const DESIGN_TOKENS_APPLY_TOOL = "design_tokens_apply";

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
  /** Record the direction and put its style in place; returns what to tell the agent, throws on a bad style. */
  setDirection(threadId: string, direction: DesignDirection, alternates?: string[], theme?: "light" | "dark"): string;
  /** The style library as one line per style, for the direction tool's description. */
  styleIndex(): string;
  /** The kit tools; only given when Design v2 is on, so they're not offered otherwise. */
  kits?: DesignKitToolDeps;
}

/** What the kit tools need from the app. Each returns what to tell the agent and throws with a message when it can't. */
export interface DesignKitToolDeps {
  inspect(threadId: string, query: { kit?: string; component?: string; block?: string; startDraft?: boolean }): string;
  save(threadId: string): string;
  applyTokens(threadId: string, rel: string, tokens: Record<string, string>): string;
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
      effect: "read",
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
        "Check a page of this design against the design rules: text contrast (4.5:1, 3:1 large), tap targets (44×44), spacing on the 4px grid, colors that aren't --color-* tokens, and generic-AI tells (eyebrow labels, gradient text, side stripes, hard shadows, identical card grids, emoji icons, overused display fonts). Returns findings with CSS selectors, worst first.",
      input: {
        path: z.string().optional().describe("Page inside the design folder; default index.html"),
        width: z.number().optional().describe("Viewport width in CSS px, 320-2560; default 1440"),
      },
      autoAllow: true,
      effect: "read",
      run: async (args) => {
        const page = pageOf(deps, threadId, args.path);
        if (!("rel" in page)) return page;
        const width = clamp(args.width, 320, 2560, 1440);
        try {
          const raw = await deps.evaluate(deps.url(threadId, page.rel), width, 900, deps.lintScript);
          const root = deps.root(threadId);
          const parsed = JSON.parse(String(raw)) as LintResult;
          const result = root ? withoutAllowed(parsed, styleAllows(root)) : parsed;
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
      effect: "mutate",
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
    define({
      name: DESIGN_DIRECTION_TOOL,
      description: [
        "Set this design's direction before you build (an Auto thread must call it first). Call it again when the user asks for a different look in words (\"make it brutalist\", \"darker, more editorial\"): pick the closest style and rebuild in it.",
        "surface: component (one card, badge, modal: no page chrome), page (scrolling site: nav, hero, sections, footer), screen (one task: login, settings), workspace (dashboard, admin, data), deck (16:9 slides), mobile (a 390×844 app screen).",
        "mode, from what the visitor must achieve on this surface (not from the product): persuade (landing, pricing: decide and act; bold, committed), operate (app UI, dashboards, settings: get a task done; precise, restrained), read (docs, articles: understand; calm structure), experience (portfolio, gallery, game: the work leads).",
        "tier: quick (rough exploration), working (everyday: tokens, states, tweaks), real-app (product-grade, critique and handoff). Use quick only when the user asks for a sketch, real-app when they ask for production or handoff.",
        "style: the style whose world fits the brief's subject and audience; a look or style the user names wins. alternates: up to 2 more styles that fit nearly as well, best first; CubiQ picks one of the three so designs vary. When the user names a look, pass no alternates. Styles:",
        deps.styleIndex(),
      ].join("\n"),
      input: {
        surface: z.enum(SURFACES).describe("What is being designed"),
        mode: z.enum(MODES).describe("What the visitor must achieve"),
        tier: z.enum(["quick", "working", "real-app"]).describe("How much discipline the prototype gets"),
        style: z.string().describe("A style id from the list (e.g. one of the ids before the colon)"),
        alternates: z.array(z.string()).optional().describe("Up to 2 runner-up style ids, best first"),
        theme: z.enum(["light", "dark"]).optional().describe("Only when the user asks for a light or dark look; styles marked dark have a dark base"),
      },
      autoAllow: true,
      effect: "mutate",
      run: async (args) => {
        try {
          return {
            text: deps.setDirection(
              threadId,
              { surface: args.surface, mode: args.mode, tier: args.tier, style: args.style },
              args.alternates ?? [],
              args.theme,
            ),
          };
        } catch (err) {
          return { text: err instanceof Error ? err.message : String(err), isError: true };
        }
      },
    }),
    ...(deps.kits ? kitTools(deps, deps.kits, threadId) : []),
  ];
}

/** Read a kit, save a draft, and rebrand a page. They never touch a component's markup except through a saved kit. */
function kitTools(deps: DesignToolDeps, kits: DesignKitToolDeps, threadId: string): HarnessTool[] {
  const guarded = (run: () => string): ToolOutput => {
    try {
      return { text: run() };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
  };
  return [
    define({
      name: DESIGN_KIT_INSPECT_TOOL,
      description:
        "Look inside a design kit. With no arguments: the active kit's components by category and its blocks, plus the other kits on this machine. component: that part's props and snippet. block: that block's HTML. kit: ask about another installed kit by id.",
      input: {
        kit: z.string().optional().describe("A kit id; default the thread's active kit"),
        component: z.string().optional().describe("A component's data-ui value"),
        block: z.string().optional().describe("A block's file name without .html"),
        start_draft: z.boolean().optional().describe("Make kit/ a working copy of the active kit, when it isn't there yet"),
      },
      autoAllow: true,
      effect: "read",
      run: async (args) => guarded(() => kits.inspect(threadId, { ...(args.kit ? { kit: args.kit } : {}), ...(args.component ? { component: args.component } : {}), ...(args.block ? { block: args.block } : {}), ...(args.start_draft ? { startDraft: true } : {}) })),
    }),
    define({
      name: DESIGN_KIT_SAVE_TOOL,
      description: `Validate the draft kit in ${deps.folder(threadId)}/kit/, save it to the project's design systems and switch this design to it, so system/ holds it. Fails with the list of what to fix. Don't call it for a component the user asked to review: they save that themselves.`,
      input: {},
      autoAllow: true,
      effect: "mutate",
      run: async () => guarded(() => kits.save(threadId)),
    }),
    define({
      name: DESIGN_TOKENS_APPLY_TOOL,
      description:
        "Rebrand a page by token values alone: one call is one undo step, and no component or layout changes. tokens: custom property names from system/tokens.css mapped to new values. Names it doesn't have are refused, so read it first. To see a reference image's colours, use your image tool on refs/.",
      input: {
        tokens: z.record(z.string(), z.string()).describe('For example {"--color-primary": "#4f46e5", "--radius-md": "10px"}'),
        path: z.string().optional().describe("Page inside the design folder; default index.html"),
      },
      autoAllow: true,
      effect: "mutate",
      run: async (args) => {
        const page = pageOf(deps, threadId, args.path);
        if (!("rel" in page)) return page;
        return guarded(() => kits.applyTokens(threadId, page.rel, args.tokens));
      },
    }),
  ];
}
