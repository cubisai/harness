// CubiQ design-system guard: one pass over the design tokens, docs and skills.
// Pure check functions take `{ path, text }[]` (text already LF-normalised);
// the CLI prints every issue and exits 1 iff any error (warnings never fail).
//
// Codes:
//   design/literal-color     error   hex/rgb()/hsl() outside a :root token declaration
//   design/type-offscale     error   font size not in TYPE_SCALE_PX
//   design/token-missing     error   var(--x) with no fallback for an undeclared --x, or a
//                                     token declared only in a dark block
//   design/token-stale       error   docs/design/tokens.md != the generated tokens
//   design/token-collision   warning the same --x declared twice in a rule, or two names
//                                     that collapse when lower-cased and stripped of -/_
//   design/theme-drift       warning the OS-dark and forced-dark blocks disagree
//   design/doc-value         warning hard-coded colour in DESIGN.md/docs/design/*.md
//   design/skill-invalid     error   a SKILL.md without frontmatter or with 500+ lines
//   design/skill-ref-unknown error   a SKILL.md links an unknown docs/design file
//   design/doc-structure     error   docs/design/README.md missing, or missing a heading
//   design/allowlist-unused  warning an allowlist entry matched nothing
//   design/component-missing error   reserved; not checked yet
//
// Run: node scripts/design-check.mjs [--json | --baseline]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Severity for every issue code (design/component-missing is reserved). */
export const SEVERITY = Object.freeze({
  "design/literal-color": "error",
  "design/type-offscale": "error",
  "design/token-missing": "error",
  "design/token-stale": "error",
  "design/token-collision": "warning",
  "design/theme-drift": "warning",
  "design/doc-value": "warning",
  "design/skill-ref-unknown": "error",
  "design/skill-invalid": "error",
  "design/doc-structure": "error",
  "design/allowlist-unused": "warning",
  "design/component-missing": "error", // reserved; not checked yet
});

/** Every font size, in px, that a design token or component may use. */
export const TYPE_SCALE_PX = [10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 18];

/** Baseline reason written by `--baseline`. */
const BASELINE_REASON = "baseline 2026-10-09: fix in UI/UX Phase 4";

/** Build an issue, omitting `value` when it is undefined. */
function issue(severity, code, file, line, message, value) {
  const out = { severity, code, file, line, message };
  if (value !== undefined) out.value = value;
  return out;
}

/** A per-text line lookup by absolute offset (1-based; 0 is never returned). */
function lineIndexer(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Replace every comment with spaces, keeping byte offsets and newlines. */
function blankCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Replace every url(...) body with spaces so hex fragments are not read as colours. */
function blankUrls(css) {
  return css.replace(/url\(([^)]*)\)/g, (_m, inner) => `url(${inner.replace(/[^\n]/g, " ")})`);
}

/** Index of the ")" matching the "(" at `openIdx`, or -1. */
function matchParen(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every hex colour and rgb()/hsl() call in a (comment-stripped) text. */
function colorMatches(text) {
  const out = [];
  let m;
  const hexRe = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b/g;
  while ((m = hexRe.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
  const fnRe = /\b(?:rgb|rgba|hsl|hsla)\(/gi;
  while ((m = fnRe.exec(text))) {
    const close = matchParen(text, m.index + m[0].length - 1);
    if (close === -1) continue;
    out.push({ start: m.index, end: close + 1, value: text.slice(m.index, close + 1) });
    fnRe.lastIndex = close + 1;
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Every top-level whitespace-separated token of a declaration value, with offsets. */
function topLevelTokens(value) {
  const tokens = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (/\s/.test(ch) && depth === 0) {
      if (start >= 0) {
        tokens.push({ text: value.slice(start, i), start });
        start = -1;
      }
    } else {
      if (start < 0) start = i;
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
    }
  }
  if (start >= 0) tokens.push({ text: value.slice(start), start });
  return tokens;
}

/** The first px size at the top level of a `font`/`font-size` value, or null. */
function pxSizeToken(value) {
  for (const t of topLevelTokens(value)) {
    const m = t.text.match(/^(\d+(?:\.\d+)?)px(?:\/[^\s]*)?$/);
    if (m) return { n: parseFloat(m[1]), raw: m[1], offset: t.start };
  }
  return null;
}

/** Parse a stylesheet into blocks `{ selector, bodyStart, bodyEnd, depth, parent }`. */
function parseCssBlocks(css) {
  const blocks = [];
  const stack = [];
  let boundary = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      const selector = css.slice(boundary, i).replace(/\s+/g, " ").trim();
      const parent = stack.length ? stack[stack.length - 1] : null;
      const block = { selector, bodyStart: i + 1, bodyEnd: css.length, depth: stack.length, parent };
      blocks.push(block);
      stack.push(block);
      boundary = i + 1;
    } else if (ch === "}") {
      const block = stack.pop();
      if (block) block.bodyEnd = i;
      boundary = i + 1;
    } else if (ch === ";") {
      boundary = i + 1;
    }
  }
  return blocks;
}

/** The deepest block whose body contains `offset`, or null. */
function innermostBlock(blocks, offset) {
  let best = null;
  for (const b of blocks) {
    if (offset > b.bodyStart && offset < b.bodyEnd) {
      if (!best || b.depth >= best.depth) best = b;
    }
  }
  return best;
}

/** The declaration text of a block that contains `offset`. */
function declarationAt(css, block, offset) {
  let start = block.bodyStart;
  for (let k = offset - 1; k >= block.bodyStart; k--) {
    if (css[k] === ";" || css[k] === "{") {
      start = k + 1;
      break;
    }
  }
  let end = block.bodyEnd;
  for (let k = offset; k < block.bodyEnd; k++) {
    if (css[k] === ";" || css[k] === "}") {
      end = k;
      break;
    }
  }
  return css.slice(start, end);
}

/** True when a declaration (`--x: ...`) is a custom-property declaration. */
function isCustomDecl(decl) {
  return /^\s*--[A-Za-z0-9_-]+\s*:/.test(decl);
}

/** Lower-case, collapse whitespace and drop spaces after "(" / before ")" for allowlist matching. */
function normalizeValue(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

/** Flag hex/rgb()/hsl() colours outside a `:root` token declaration. */
export function checkLiteralColors(files) {
  const issues = [];
  for (const file of files) {
    if (file.path.endsWith(".css")) {
      const css = blankUrls(blankCssComments(file.text));
      const blocks = parseCssBlocks(css);
      const lineOf = lineIndexer(css);
      for (const m of colorMatches(css)) {
        const block = innermostBlock(blocks, m.start);
        const allowed = block && block.selector.includes(":root") && isCustomDecl(declarationAt(css, block, m.start));
        if (allowed) continue;
        issues.push(issue("error", "design/literal-color", file.path, lineOf(m.start), `literal colour ${m.value}; use a token`, m.value));
      }
    } else if (file.path.endsWith(".ts") || file.path.endsWith(".tsx")) {
      const lines = file.text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        const segRe = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
        let m;
        while ((m = segRe.exec(line))) {
          for (const c of colorMatches(m[0])) {
            issues.push(issue("error", "design/literal-color", file.path, i + 1, `literal colour ${c.value}; use a token`, c.value));
          }
        }
      }
    }
  }
  return issues;
}

/** Flag font sizes that are not in TYPE_SCALE_PX. */
export function checkTypeScale(files) {
  const issues = [];
  for (const file of files) {
    if (file.path.endsWith(".css")) {
      const css = blankCssComments(file.text);
      const lineOf = lineIndexer(css);
      let m;
      const fontSizeRe = /(^|[;{\s])font-size\s*:\s*([^;}\n]+)/gi;
      while ((m = fontSizeRe.exec(css))) {
        const value = m[2];
        const size = pxSizeToken(value);
        if (!size || TYPE_SCALE_PX.includes(size.n)) continue;
        const off = m.index + m[0].indexOf(value) + size.offset;
        issues.push(issue("error", "design/type-offscale", file.path, lineOf(off), `font-size ${size.raw}px is off the type scale`, `${size.raw}px`));
      }
      const fontRe = /(^|[;{\s])font\s*:\s*([^;}\n]+)/gi;
      while ((m = fontRe.exec(css))) {
        const value = m[2];
        const size = pxSizeToken(value);
        if (!size || TYPE_SCALE_PX.includes(size.n)) continue;
        const off = m.index + m[0].indexOf(value) + size.offset;
        issues.push(issue("error", "design/type-offscale", file.path, lineOf(off), `font ${size.raw}px is off the type scale`, `${size.raw}px`));
      }
    } else if (file.path.endsWith(".ts") || file.path.endsWith(".tsx")) {
      const lineOf = lineIndexer(file.text);
      const re = /fontSize\s*:\s*"(\d+(?:\.\d+)?)px"|fontSize\s*:\s*(\d+(?:\.\d+)?)/g;
      let m;
      while ((m = re.exec(file.text))) {
        const raw = m[1] ?? m[2];
        const n = parseFloat(raw);
        if (TYPE_SCALE_PX.includes(n)) continue;
        issues.push(issue("error", "design/type-offscale", file.path, lineOf(m.index), `fontSize ${raw} is off the type scale`, `${raw}px`));
      }
    }
  }
  return issues;
}

/** Flag `var(--x)` with no fallback for an undeclared token, and dark-only tokens. */
export function checkTokenRefs(files) {
  const issues = [];
  const declared = new Set();
  for (const file of files) {
    if (file.path.endsWith(".css")) {
      const css = blankCssComments(file.text);
      let m;
      const declRe = /--([A-Za-z0-9_-]+)\s*:/g;
      while ((m = declRe.exec(css))) declared.add(m[1]);
      const propRe = /@property\s+--([A-Za-z0-9_-]+)/g;
      while ((m = propRe.exec(css))) declared.add(m[1]);
    } else if (file.path.endsWith(".ts") || file.path.endsWith(".tsx")) {
      let m;
      const quoteRe = /["'`]--([A-Za-z0-9_-]+)["'`]/g;
      while ((m = quoteRe.exec(file.text))) declared.add(m[1]);
    }
  }

  for (const file of files) {
    if (!(file.path.endsWith(".css") || file.path.endsWith(".ts") || file.path.endsWith(".tsx"))) continue;
    const text = file.path.endsWith(".css") ? blankCssComments(file.text) : file.text;
    const lineOf = lineIndexer(text);
    const re = /\bvar\(\s*--([A-Za-z0-9_-]+)\s*(,?)/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[2] === ",") continue;
      const name = m[1];
      if (declared.has(name)) continue;
      issues.push(issue("error", "design/token-missing", file.path, lineOf(m.index), `var(--${name}) has no fallback and --${name} is not declared`, `var(--${name})`));
    }
  }

  const light = new Set();
  const darkRecords = [];
  for (const file of files) {
    if (!file.path.endsWith(".css")) continue;
    const css = blankCssComments(file.text);
    const lineOf = lineIndexer(css);
    for (const block of parseCssBlocks(css)) {
      if (!block.selector.includes(":root")) continue;
      const parentSel = block.parent ? block.parent.selector : "";
      const darkMedia = /@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(parentSel);
      const isDark = /data-theme\s*=\s*["']dark["']/.test(block.selector) || (darkMedia && /:root/.test(block.selector));
      const body = css.slice(block.bodyStart, block.bodyEnd);
      const re = /--([A-Za-z0-9_-]+)\s*:/g;
      let m;
      while ((m = re.exec(body))) {
        if (isDark) darkRecords.push({ file: file.path, line: lineOf(block.bodyStart + m.index), name: m[1] });
        else light.add(m[1]);
      }
    }
  }
  const reported = new Set();
  for (const rec of darkRecords) {
    if (light.has(rec.name) || reported.has(rec.name)) continue;
    reported.add(rec.name);
    issues.push(issue("error", "design/token-missing", rec.file, rec.line, `--${rec.name} is declared only in dark mode; add a :root default`, `--${rec.name}`));
  }
  return issues;
}

/** Flag a custom property declared twice in one rule, or two colliding token names. */
export function checkTokenCollisions(files) {
  const issues = [];
  const normalized = new Map();
  for (const file of files) {
    if (!file.path.endsWith(".css")) continue;
    const css = blankCssComments(file.text);
    const lineOf = lineIndexer(css);
    const blocks = parseCssBlocks(css);
    for (const block of blocks) {
      const body = css.slice(block.bodyStart, block.bodyEnd);
      const seen = new Set();
      const re = /--([A-Za-z0-9_-]+)\s*:/g;
      let m;
      while ((m = re.exec(body))) {
        const off = block.bodyStart + m.index;
        if (innermostBlock(blocks, off) !== block) continue;
        const name = m[1];
        if (seen.has(name)) {
          issues.push(issue("warning", "design/token-collision", file.path, lineOf(off), `--${name} is declared more than once in the same rule`, `--${name}`));
        } else {
          seen.add(name);
        }
        if (block.selector.includes(":root")) {
          const key = name.toLowerCase().replace(/[-_]/g, "");
          const prev = normalized.get(key);
          if (!prev) normalized.set(key, { name: `--${name}`, file: file.path, line: lineOf(off) });
          else if (prev.name !== `--${name}`) {
            issues.push(issue("warning", "design/token-collision", file.path, lineOf(off), `tokens ${prev.name} and --${name} collide after normalisation`, `${prev.name} --${name}`));
          }
        }
      }
    }
  }
  return issues;
}

/** The custom-property map (name -> { value, line }) declared directly in a block. */
function tokenMap(css, block, lineOf) {
  const map = new Map();
  const body = css.slice(block.bodyStart, block.bodyEnd);
  const re = /--([A-Za-z0-9_-]+)\s*:\s*([^;}\n]*)/g;
  let m;
  while ((m = re.exec(body))) {
    if (map.has(m[1])) continue;
    map.set(m[1], { value: m[2].trim(), line: lineOf(block.bodyStart + m.index) });
  }
  return map;
}

/** Flag tokens that differ between the OS-dark and the forced-dark blocks. */
export function checkThemeDrift(files) {
  const issues = [];
  for (const file of files) {
    if (!file.path.endsWith(".css")) continue;
    const css = blankCssComments(file.text);
    const lineOf = lineIndexer(css);
    let mediaDark = null;
    let forcedDark = null;
    for (const block of parseCssBlocks(css)) {
      const sel = block.selector;
      if (/^:root:not\(\[data-theme\s*=\s*["']light["']\]\)$/.test(sel)) {
        const parentSel = block.parent ? block.parent.selector : "";
        if (/@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(parentSel)) mediaDark = block;
      }
      if (/^:root\[data-theme\s*=\s*["']dark["']\]$/.test(sel)) forcedDark = block;
    }
    if (!mediaDark || !forcedDark) continue;
    const media = tokenMap(css, mediaDark, lineOf);
    const forced = tokenMap(css, forcedDark, lineOf);
    const names = new Set([...media.keys(), ...forced.keys()]);
    for (const name of names) {
      const a = media.get(name);
      const b = forced.get(name);
      if (a && b) {
        if (a.value !== b.value) {
          issues.push(issue("warning", "design/theme-drift", file.path, b.line, `--${name} differs between OS-dark and forced-dark (${a.value} vs ${b.value})`, `--${name}`));
        }
      } else {
        const line = (b ?? a).line;
        issues.push(issue("warning", "design/theme-drift", file.path, line, `--${name} exists in only one dark block`, `--${name}`));
      }
    }
  }
  return issues;
}

/** Flag hard-coded colours in DESIGN.md and docs/design/*.md (except tokens.md). */
export function checkDocValues(files) {
  const issues = [];
  for (const file of files) {
    const isDoc = file.path === "DESIGN.md" || (/^docs\/design\/[^/]+\.md$/.test(file.path) && file.path !== "docs/design/tokens.md");
    if (!isDoc) continue;
    const lineOf = lineIndexer(file.text);
    for (const m of colorMatches(file.text)) {
      issues.push(issue("warning", "design/doc-value", file.path, lineOf(m.start), `hard-coded colour ${m.value} in docs; show a token instead`, m.value));
    }
  }
  return issues;
}

/** Validate each skill's SKILL.md frontmatter, length and doc references. */
export function checkSkills(files) {
  const issues = [];
  const known = new Set(files.map((f) => f.path));
  for (const file of files) {
    if (!/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(file.path)) continue;
    const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(file.text);
    let invalid = !fm;
    if (fm) {
      const name = /^name:[ \t]*(\S.*)$/m.exec(fm[1]);
      const description = /^description:[ \t]*(\S.*)$/m.exec(fm[1]);
      if (!name || !description) invalid = true;
    }
    if (invalid) {
      issues.push(issue("error", "design/skill-invalid", file.path, 1, "SKILL.md needs leading frontmatter with non-empty name and description"));
    }
    const lineCount = file.text.split("\n").length;
    if (lineCount >= 500) {
      issues.push(issue("error", "design/skill-invalid", file.path, 0, `SKILL.md has ${lineCount} lines; keep it under 500`));
    }
    const lineOf = lineIndexer(file.text);
    const refRe = /(docs\/design\/[A-Za-z0-9_.-]+\.md|DESIGN\.md)/g;
    let m;
    while ((m = refRe.exec(file.text))) {
      if (known.has(m[1])) continue;
      issues.push(issue("error", "design/skill-ref-unknown", file.path, lineOf(m.index), `references unknown path ${m[1]}`, m[1]));
    }
  }
  return issues;
}

/** Require the docs/design/README.md router and its four headings. */
export function checkRouter(files) {
  const readme = files.find((f) => f.path === "docs/design/README.md");
  if (!readme) return [issue("error", "design/doc-structure", "docs/design/README.md", 0, "docs/design/README.md is missing")];
  const issues = [];
  for (const heading of ["## Read Order", "## Design Highlights", "## Do", "## Avoid"]) {
    const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
    if (!re.test(readme.text)) {
      issues.push(issue("error", "design/doc-structure", readme.path, 0, `docs/design/README.md is missing the "${heading}" heading`));
    }
  }
  return issues;
}

/** Flag a missing or stale docs/design/tokens.md against the injected generator. */
export function checkTokensDoc(files, generateTokensMd) {
  if (typeof generateTokensMd !== "function") return [];
  const appCss = files.find((f) => f.path === "src/renderer/src/styles/app.css");
  const tokens = files.find((f) => f.path === "docs/design/tokens.md");
  const generated = generateTokensMd(appCss ? appCss.text : "");
  if (!tokens || tokens.text !== generated) {
    return [issue("error", "design/token-stale", "docs/design/tokens.md", 0, "docs/design/tokens.md is stale; regenerate with bun run design:docs")];
  }
  return [];
}

/** Drop allowlisted issues and turn unmatched entries into warnings. */
export function applyAllowlist(issues, allowlist) {
  const entries = Array.isArray(allowlist) ? allowlist : [];
  const used = new Set();
  const kept = [];
  for (const it of issues) {
    let matched = false;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.code !== it.code || e.file !== it.file) continue;
      if (normalizeValue(e.value) !== normalizeValue(it.value)) continue;
      used.add(i);
      matched = true;
      break;
    }
    if (!matched) kept.push(it);
  }
  const unused = [];
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const e = entries[i];
    unused.push(issue("warning", "design/allowlist-unused", "scripts/design-allowlist.json", 0, `allowlist entry ${e.code} for ${e.file} is unused`, e.value ?? ""));
  }
  return { issues: kept, unused };
}

/** Compare two issues by file, then line, then code. */
function compareIssues(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return 0;
}

/** Run every check, apply the allowlist and return issues sorted by file/line/code. */
export function runChecks(files, options = {}) {
  const { generateTokensMd, allowlist } = options;
  const all = [
    ...checkLiteralColors(files),
    ...checkTypeScale(files),
    ...checkTokenRefs(files),
    ...checkTokenCollisions(files),
    ...checkThemeDrift(files),
    ...checkDocValues(files),
    ...checkSkills(files),
    ...checkRouter(files),
    ...checkTokensDoc(files, generateTokensMd),
  ];
  const { issues, unused } = applyAllowlist(all, allowlist);
  return [...issues, ...unused].sort(compareIssues);
}

/** Render one issue as `<severity> <code> <file>:<line> <message> [<value>]`. */
export function formatIssue(it) {
  const base = `${it.severity} ${it.code} ${it.file}:${it.line} ${it.message}`;
  return it.value ? `${base} [${it.value}]` : base;
}

/** Convert an absolute path to a repo-relative path with forward slashes. */
function toPosix(p) {
  return p.split(sep).join("/");
}

/** Recursively collect files under `dir` whose name ends with one of `exts`. */
function walkDir(dir, exts, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkDir(p, exts, out);
    else if (ent.isFile() && exts.some((ext) => ent.name.endsWith(ext))) out.push(p);
  }
}

/** Collect and read every file the guard scans, with LF-normalised text. */
function collectFiles(root) {
  const abs = [];
  walkDir(join(root, "src", "renderer", "src"), [".css", ".ts", ".tsx"], abs);
  walkDir(join(root, "src", "main", "browser"), [".ts"], abs);
  const design = join(root, "DESIGN.md");
  if (existsSync(design)) abs.push(design);
  walkDir(join(root, "docs", "design"), [".md"], abs);
  const skillsDir = join(root, ".claude", "skills");
  try {
    for (const ent of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = join(skillsDir, ent.name, "SKILL.md");
      if (existsSync(p)) abs.push(p);
    }
  } catch {
    /* no .claude/skills yet */
  }
  const seen = new Set();
  const files = [];
  for (const p of abs.sort()) {
    const rel = toPosix(relative(root, p));
    if (seen.has(rel)) continue;
    seen.add(rel);
    files.push({ path: rel, text: readFileSync(p, "utf8").replace(/\r\n?/g, "\n") });
  }
  return files;
}

/** Read scripts/design-allowlist.json, or an empty list when missing/invalid. */
function readAllowlist(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write one deduplicated baseline entry per current literal-colour/type error. */
function writeBaseline(files, path) {
  const raw = [...checkLiteralColors(files), ...checkTypeScale(files)];
  const seen = new Map();
  for (const it of raw) {
    const key = `${it.code}\u0000${it.file}\u0000${normalizeValue(it.value)}`;
    if (seen.has(key)) continue;
    seen.set(key, { code: it.code, file: it.file, value: it.value ?? "", reason: BASELINE_REASON });
  }
  const entries = [...seen.values()].sort(
    (a, b) => a.code.localeCompare(b.code) || a.file.localeCompare(b.file) || a.value.localeCompare(b.value),
  );
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  console.log(`design:check: wrote ${entries.length} baseline entries to scripts/design-allowlist.json`);
}

/** The CLI: collect the tree, run the checks, print and set the exit code. */
async function main() {
  const args = process.argv.slice(2);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = collectFiles(root);
  const allowlistPath = join(root, "scripts", "design-allowlist.json");
  if (args.includes("--baseline")) {
    writeBaseline(files, allowlistPath);
    return;
  }
  const allowlist = readAllowlist(allowlistPath);
  const docs = await import("./design-docs.mjs").catch(() => null);
  const generateTokensMd = docs && typeof docs.generateTokensMd === "function" ? docs.generateTokensMd : null;
  let issues = runChecks(files, { generateTokensMd, allowlist });
  if (!generateTokensMd) {
    issues = [...issues, issue("error", "design/token-stale", "scripts/design-docs.mjs", 0, "scripts/design-docs.mjs is missing")].sort(compareIssues);
  }
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
  } else {
    for (const it of issues) console.log(formatIssue(it));
    console.log(`design:check: ${errors} errors, ${warnings} warnings`);
  }
  process.exitCode = errors > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
