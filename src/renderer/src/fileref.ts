export interface FileRef {
  path: string;
  line?: number;
  column?: number;
}

/** Extensions that make a bare name (no folder) a file: `req.ip` is code, `index.ts` is a file. */
const KNOWN = new Set(
  (
    "ts tsx js jsx mjs cjs json jsonc md mdx txt py pyi rb go rs java kt kts swift c h cc cpp hpp cs php html htm css scss sass less " +
    "vue svelte astro yml yaml toml ini cfg conf env lock sh bash zsh fish ps1 sql graphql gql proto xml csv tsv tf gradle lua dart " +
    "ex exs erl hs ml scala clj r m mm vim plist properties dockerfile makefile log svg png jpg jpeg gif webp ico pdf"
  ).split(" "),
);

const REF = /^(?:\.\/)?((?:[A-Za-z]:[\\/]|\/|~\/)?(?:[\w@.+-]+[\\/])*\.?[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?::(\d+))?|#L(\d+))?$/;

/**
 * A file reference the way agents write one: `src/a.ts`, `src/a.ts:42`,
 * `src/a.ts:42:7`, or `a.ts#L42`. Not URLs, globs, version numbers, or
 * anything with spaces, so ordinary inline code stays plain.
 */
export function parseFileRef(text: string): FileRef | null {
  const t = text.trim();
  if (!t || t.length > 300 || t.includes("://") || /[\s*?<>|"]/.test(t)) return null;
  const m = REF.exec(t);
  if (!m) return null;
  const path = m[1]!;
  // "e.g." and "v1.2" aren't files: the name needs a letter before the extension dot.
  const base = path.split(/[\\/]/).pop()!;
  if (!/[A-Za-z_]/.test(base.slice(0, base.lastIndexOf(".")) || "") && !base.startsWith(".")) return null;
  const ext = base.slice(base.lastIndexOf(".") + 1).toLowerCase();
  if (!/[\\/]/.test(path) && !base.startsWith(".") && !KNOWN.has(ext)) return null;
  const line = Number(m[2] ?? m[4]) || undefined;
  const column = line ? Number(m[3]) || undefined : undefined;
  return { path, ...(line && { line }), ...(column && { column }) };
}
