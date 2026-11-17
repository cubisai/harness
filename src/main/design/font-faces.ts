import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DesignFontFace } from "../../shared/types";

/** One `@font-face` rule that loads a `.woff2` from the folder's `fonts/`. */
export interface FontFaceRule {
  family: string;
  file: string;
  weight?: string;
  style?: string;
  unicodeRange?: string;
}

const MAX_FACES = 16;
const MAX_FONT_BYTES = 4 * 1024 * 1024;

const unquote = (s: string): string => s.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/** The `@font-face` rules in `css` whose `src` is a `fonts/<name>.woff2` beside it; others are skipped. */
export function parseFontFaces(css: string): FontFaceRule[] {
  const out: FontFaceRule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const decl = (name: string): string | undefined => {
      const hit = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(m[1]!);
      return hit ? hit[1]!.trim() : undefined;
    };
    const family = decl("font-family");
    const src = decl("src");
    const file = src && /url\(\s*["']?\.?\/?fonts\/([\w.-]+\.woff2)["']?\s*\)/i.exec(src)?.[1];
    if (!family || !file) continue;
    const weight = decl("font-weight");
    const style = decl("font-style");
    const unicodeRange = decl("unicode-range");
    out.push({ family: unquote(family), file, ...(weight ? { weight } : {}), ...(style ? { style } : {}), ...(unicodeRange ? { unicodeRange } : {}) });
  }
  return out;
}

/** The font faces a design's `system/` CSS declares, with each file's bytes; [] when it has none. */
export function systemFontFaces(systemDir: string): DesignFontFace[] {
  let cssFiles: string[];
  try {
    cssFiles = readdirSync(systemDir).filter((f) => f.endsWith(".css")).sort();
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const faces: DesignFontFace[] = [];
  for (const name of cssFiles) {
    let css: string;
    try {
      css = readFileSync(join(systemDir, name), "utf8");
    } catch {
      continue;
    }
    for (const rule of parseFontFaces(css)) {
      if (faces.length >= MAX_FACES) return faces;
      const key = `${rule.family}|${rule.file}|${rule.style ?? ""}|${rule.unicodeRange ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const path = join(systemDir, "fonts", rule.file);
      try {
        if (statSync(path).size > MAX_FONT_BYTES) continue;
        faces.push({ ...rule, data: new Uint8Array(readFileSync(path)) });
      } catch {
        // A rule may name a file the folder doesn't have.
      }
    }
  }
  return faces;
}
