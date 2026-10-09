// Types for the design-system guard in scripts/design-check.mjs.

/** A file to check; `text` is already LF-normalised. */
export interface DesignFile {
  path: string;
  text: string;
}

/** One design-system finding. */
export interface DesignIssue {
  severity: "error" | "warning";
  code: string;
  file: string;
  line: number;
  message: string;
  value?: string;
}

/** An allowlist entry as stored in scripts/design-allowlist.json. */
export interface DesignAllowlistEntry {
  code: string;
  file: string;
  value: string;
  reason: string;
}

/** The allowlist match result. `unused` entries are already design/allowlist-unused warnings. */
export interface AllowlistResult {
  issues: DesignIssue[];
  unused: DesignIssue[];
}

/** Severity for every issue code (design/component-missing is reserved). */
export const SEVERITY: Readonly<Record<string, "error" | "warning">>;

/** Every font size, in px, that a design token or component may use. */
export const TYPE_SCALE_PX: readonly number[];

/** Flag hex/rgb()/hsl() colours outside a `:root` token declaration. */
export function checkLiteralColors(files: DesignFile[]): DesignIssue[];

/** Flag font sizes that are not in TYPE_SCALE_PX. */
export function checkTypeScale(files: DesignFile[]): DesignIssue[];

/** Flag `var(--x)` with no fallback for an undeclared token, and dark-only tokens. */
export function checkTokenRefs(files: DesignFile[]): DesignIssue[];

/** Flag a custom property declared twice in one rule, or two colliding token names. */
export function checkTokenCollisions(files: DesignFile[]): DesignIssue[];

/** Flag tokens that differ between the OS-dark and the forced-dark blocks. */
export function checkThemeDrift(files: DesignFile[]): DesignIssue[];

/** Flag hard-coded colours in DESIGN.md and docs/design/*.md (except tokens.md). */
export function checkDocValues(files: DesignFile[]): DesignIssue[];

/** Validate each skill's SKILL.md frontmatter, length and doc references. */
export function checkSkills(files: DesignFile[]): DesignIssue[];

/** Require the docs/design/README.md router and its four headings. */
export function checkRouter(files: DesignFile[]): DesignIssue[];

/** Flag a missing or stale docs/design/tokens.md against the injected generator. */
export function checkTokensDoc(files: DesignFile[], generateTokensMd: (css: string) => string): DesignIssue[];

/** Drop allowlisted issues and turn unmatched entries into warnings. */
export function applyAllowlist(issues: DesignIssue[], allowlist: DesignAllowlistEntry[]): AllowlistResult;

/** Run every check, apply the allowlist and return issues sorted by file/line/code. */
export function runChecks(files: DesignFile[], options?: { generateTokensMd?: (css: string) => string; allowlist?: DesignAllowlistEntry[] }): DesignIssue[];

/** Render one issue as `<severity> <code> <file>:<line> <message> [<value>]`. */
export function formatIssue(issue: DesignIssue): string;
