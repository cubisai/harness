import type { Thread } from "./types";

/** A design thread's folder, relative to the thread's working folder: stable, since titles change. */
export function designDirName(threadId: string): string {
  return `designs/${threadId.slice(0, 8)}`;
}

/** An alternative version of the main page, e.g. `variant-a.html`, sitting beside it. */
export const VARIANT_RE = /^variant-[a-z0-9][a-z0-9-]{0,31}\.html?$/i;

/** True when `rel` names a variant page in the design folder's root (never in a subfolder). */
export function isVariant(rel: string): boolean {
  return !rel.includes("/") && !rel.includes("\\") && VARIANT_RE.test(rel);
}

/** A variant's short label for the UI: "variant-dense-hero.html" -> "Dense hero". Anything else as it is. */
export function variantLabel(rel: string): string {
  if (!isVariant(rel)) return rel;
  const words = rel.replace(/^variant-|\.html?$/gi, "").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The design's developer handoff, beside its pages (written by the design-review skill). */
export function handoffPath(dir: string): string {
  return `${dir}/handoff.md`;
}

/**
 * The first message of the chat thread that builds a design into the codebase: read the handoff and the pages, then
 * implement with the project's own components and tokens (not the prototype's HTML), keep the design's intent, run
 * the project's checks.
 */
export function buildInCodePrompt(dir: string): string {
  return [
    `Build the design in \`${dir}/\` into this codebase.`,
    "",
    `1. Read \`${handoffPath(dir)}\` (tokens, components, states, breakpoints), then look at \`${dir}/index.html\` and its other pages.`,
    "2. Find where it belongs in the app and implement it with the project's real components, styles and tokens. Don't copy the prototype's HTML or CSS wholesale, and don't add its `system/tokens.css`.",
    "3. Keep the design's layout, hierarchy, copy and states. Where the codebase's conventions disagree, follow the codebase and say what you changed.",
    "4. Run the project's checks (typecheck, tests) and list the files you changed.",
  ].join("\n");
}

type BuildFields = Pick<Thread, "model" | "effort" | "contextWindow">;

/**
 * What a Build in code chat thread takes from its design thread: the same model, effort and context
 * window. The permission mode stays the chat default, since this thread edits the codebase itself.
 */
export function buildThreadPatch(design: BuildFields, thread: BuildFields): Partial<BuildFields> {
  const patch: Partial<BuildFields> = {};
  if (design.model !== thread.model) patch.model = design.model;
  if (design.effort !== thread.effort) patch.effort = design.effort;
  if ((design.contextWindow ?? null) !== (thread.contextWindow ?? null)) patch.contextWindow = design.contextWindow ?? null;
  return patch;
}

/** The tokens a brand colour rewrites (with their tints), where a kit has them: System mode asks their reach first. */
export const BRAND_TOKENS = [
  "--color-primary",
  "--color-primary-hover",
  "--color-primary-active",
  "--color-primary-light",
  "--color-primary-dark",
  "--color-primary-fill",
  "--color-primary-text",
  "--color-primary-border",
  "--color-primary-border-hover",
  "--color-primary-bg",
  "--color-primary-bg-hover",
  "--color-primary-soft",
  "--color-accent",
  "--color-accent-soft",
  "--color-accent-text",
  "--color-focus",
  "--color-on-primary",
  "--color-on-primary-fill",
] as const;
