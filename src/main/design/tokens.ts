import type { DesignToken, DesignTokenGroup } from "../../shared/types";

/** One brace-delimited CSS block: its prelude, its enclosing prelude, and its index range. */
interface CssBlock {
  /** The text before its `{`, comments stripped and trimmed (`:root`, `@media (…)`). */
  prelude: string;
  /** The prelude of the block that encloses it, or null at the top level. */
  parent: string | null;
  /** The index just after its opening `{`. */
  contentStart: number;
  /** The index of its closing `}`. */
  end: number;
}

/** `text` without its CSS comments, trimmed. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").trim();
}

/** Every brace-delimited block in `css`, comments skipped; an unclosed brace contributes nothing. */
function findBlocks(css: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  const stack: { prelude: string; open: number }[] = [];
  let preludeStart = 0;
  let i = 0;
  while (i < css.length) {
    if (css[i] === "/" && css[i + 1] === "*") {
      i += 2;
      while (i < css.length && !(css[i] === "*" && css[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    const ch = css[i];
    if (ch === "{") {
      stack.push({ prelude: stripComments(css.slice(preludeStart, i)), open: i });
      preludeStart = i + 1;
    } else if (ch === "}") {
      const open = stack.pop();
      if (open) {
        blocks.push({
          prelude: open.prelude,
          parent: stack.length ? stack[stack.length - 1]!.prelude : null,
          contentStart: open.open + 1,
          end: i,
        });
      }
      preludeStart = i + 1;
    } else if (ch === ";") {
      preludeStart = i + 1;
    }
    i += 1;
  }
  return blocks;
}

/** True for the prelude of a `prefers-color-scheme: dark` media query, whitespace-insensitively. */
function isDarkMedia(prelude: string | null): boolean {
  return prelude !== null && /prefers-color-scheme\s*:\s*dark/.test(prelude);
}

/** A declaration line's value, without its trailing `;` or surrounding whitespace. */
function declarationValue(text: string): string {
  const value = text.trim();
  return value.endsWith(";") ? value.slice(0, -1).trim() : value;
}

/** Every `--name: value` declaration in a block's text; a later duplicate wins. */
function collectDeclarations(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const match = /^(--[A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw.trim());
    if (match) out.set(match[1]!, declarationValue(match[2]!));
  }
  return out;
}

/** A group comment's title: "Color (light)" → "Color", "Space: the 8pt scale (…)" → "Space". */
function groupTitle(text: string): string {
  const withoutNote = text.replace(/\s*\([^()]*\)\s*$/, "");
  const colon = withoutNote.indexOf(":");
  return (colon === -1 ? withoutNote : withoutNote.slice(0, colon)).trim();
}

/** The top-level `:root` block, when the CSS has one. */
function lightBlockOf(blocks: CssBlock[]): CssBlock | undefined {
  return blocks.find((b) => b.prelude === ":root" && b.parent === null);
}

/** The `:root` block inside the dark color-scheme media query, when the CSS has one. */
function darkBlockOf(blocks: CssBlock[]): CssBlock | undefined {
  return blocks.find((b) => b.prelude === ":root" && isDarkMedia(b.parent));
}

/** Parse a tokens.css into its comment-titled groups: each token's light value and dark override. */
export function parseTokens(css: string): DesignTokenGroup[] {
  const blocks = findBlocks(css);
  const light = lightBlockOf(blocks);
  const dark = darkBlockOf(blocks);
  const darkValues = dark ? collectDeclarations(css.slice(dark.contentStart, dark.end)) : new Map<string, string>();

  const groups: DesignTokenGroup[] = [];
  let title = "Other";
  let tokens: DesignToken[] = [];
  const flush = (): void => {
    if (tokens.length) groups.push({ title, tokens });
    tokens = [];
  };
  for (const raw of (light ? css.slice(light.contentStart, light.end) : "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const comment = /^\/\*(.*)\*\/$/.exec(line);
    if (comment) {
      flush();
      title = groupTitle(comment[1]!);
      continue;
    }
    const match = /^(--[A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    tokens.push({ name, light: declarationValue(match[2]!), dark: darkValues.get(name) ?? null });
  }
  flush();

  const named = new Set(groups.flatMap((group) => group.tokens.map((token) => token.name)));
  const darkOnly = Array.from(darkValues).filter(([name]) => !named.has(name));
  if (darkOnly.length) {
    let other = groups.find((group) => group.title === "Other");
    if (!other) {
      other = { title: "Other", tokens: [] };
      groups.push(other);
    }
    for (const [name, value] of darkOnly) other.tokens.push({ name, light: "", dark: value });
  }
  return groups;
}

/** A settable token name. */
const TOKEN_NAME = /^--[A-Za-z0-9_-]+$/;

/** A declaration's value position within a block, or null when the block has no such declaration. */
function findDeclaration(css: string, block: CssBlock, name: string): { valueStart: number; valueEnd: number } | null {
  let offset = block.contentStart;
  for (const raw of css.slice(block.contentStart, block.end).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const match = /^(\s*)(--[A-Za-z0-9_-]+)(\s*:\s*)(.*?)(\s*;?[ \t]*)$/.exec(line);
    if (match && match[2] === name) {
      const valueStart = offset + match[1]!.length + match[2]!.length + match[3]!.length;
      return { valueStart, valueEnd: valueStart + match[4]!.length };
    }
    offset += raw.length + 1;
  }
  return null;
}

/** The leading whitespace of a block's first declaration, or null when it has none. */
function firstIndent(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^([ \t]*)(--[A-Za-z0-9_-]+)\s*:/.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (match) return match[1]!;
  }
  return null;
}

/** Insert a declaration as the block's last entry, leaving its closing brace in place. */
function insertInBlock(css: string, block: CssBlock, name: string, value: string): string {
  const content = css.slice(block.contentStart, block.end);
  const lastBreak = content.lastIndexOf("\n");
  const at = lastBreak === -1 ? block.contentStart : block.contentStart + lastBreak + 1;
  const indent = firstIndent(content) ?? "    ";
  return `${css.slice(0, at)}${indent}${name}: ${value};\n${css.slice(at)}`;
}

/** Append a fresh dark `@media` block, one blank line after the file's end. */
function appendDarkBlock(css: string, name: string, value: string): string {
  const base = css.endsWith("\n") ? css : `${css}\n`;
  return `${base}\n@media (prefers-color-scheme: dark) {\n  :root {\n    ${name}: ${value};\n  }\n}\n`;
}

/** Set one token's value for a scheme, rewriting only that declaration; throws on a bad name, value or unknown token. */
export function setToken(css: string, name: string, scheme: "light" | "dark", value: string): string {
  if (!TOKEN_NAME.test(name)) throw new Error("Invalid token name.");
  const next = value.trim();
  if (!next || next.length > 200 || /[;{}\r\n]/.test(next) || next.includes("/*") || next.includes("*/")) {
    throw new Error("Invalid token value.");
  }

  const blocks = findBlocks(css);
  const light = lightBlockOf(blocks);
  const dark = darkBlockOf(blocks);
  const inLight = light ? findDeclaration(css, light, name) : null;
  const inDark = dark ? findDeclaration(css, dark, name) : null;
  if (!inLight && !inDark) throw new Error(`Unknown token ${name}.`);

  if (scheme === "light") {
    if (!inLight) throw new Error(`Unknown token ${name}.`);
    return `${css.slice(0, inLight.valueStart)}${next}${css.slice(inLight.valueEnd)}`;
  }
  if (inDark) return `${css.slice(0, inDark.valueStart)}${next}${css.slice(inDark.valueEnd)}`;
  return dark ? insertInBlock(css, dark, name, next) : appendDarkBlock(css, name, next);
}
