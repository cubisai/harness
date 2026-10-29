import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseColor } from "../src/main/design/lint";
import { parseTokens } from "../src/main/design/tokens";

const STYLES = join(__dirname, "../resources/design-styles");

/** Text roles on the surfaces they sit on (4.5:1), and the strong border on a surface (3:1, a UI component). */
const PAIRS: [string, string, number][] = [
  ["text", "bg", 4.5],
  ["text", "surface", 4.5],
  ["text", "surface-2", 4.5],
  ["text-muted", "bg", 4.5],
  ["text-muted", "surface", 4.5],
  ["on-primary", "primary", 4.5],
  ["on-accent", "accent", 4.5],
  ["accent-text", "bg", 4.5],
  ["accent-text", "surface", 4.5],
  ["accent-text", "accent-soft", 4.5],
  ["success", "surface", 4.5],
  ["warning", "surface", 4.5],
  ["danger", "surface", 4.5],
  ["success", "success-soft", 4.5],
  ["warning", "warning-soft", 4.5],
  ["danger", "danger-soft", 4.5],
  ["border-strong", "surface", 3],
];

/** Every style's colour roles per scheme it ships: light, plus dark when it has a dark pair. */
function schemes(style: string): { scheme: string; colors: Map<string, string> }[] {
  const tokens = parseTokens(readFileSync(join(STYLES, style, "tokens.css"), "utf8")).flatMap((group) => group.tokens);
  const light = new Map(tokens.filter((t) => t.light).map((t) => [t.name, t.light]));
  const out = [{ scheme: "light", colors: light }];
  if (tokens.some((t) => t.dark)) out.push({ scheme: "dark", colors: new Map(tokens.map((t) => [t.name, t.dark ?? t.light])) });
  return out;
}

describe("design style palettes", () => {
  const styles = readdirSync(STYLES).filter((name) => !name.startsWith("."));

  it.each(styles)("%s passes every contrast pair in each scheme it ships", (style) => {
    const failures: string[] = [];
    for (const { scheme, colors } of schemes(style)) {
      for (const [fg, bg, need] of PAIRS) {
        const a = parseColor(colors.get(`--color-${fg}`) ?? "");
        const b = parseColor(colors.get(`--color-${bg}`) ?? "");
        if (!a || !b) {
          failures.push(`${scheme}: --color-${fg} or --color-${bg} missing`);
          continue;
        }
        const ratio = contrastRatio(a, b);
        if (ratio < need) failures.push(`${scheme}: ${fg} on ${bg} is ${ratio.toFixed(2)}, needs ${need}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it.each(styles)("%s ships a dark pair unless it is dark already", (style) => {
    const css = readFileSync(join(STYLES, style, "tokens.css"), "utf8");
    const darkNative = /:root\s*\{[^}]*color-scheme:\s*dark/.test(css.slice(0, css.indexOf("@media")));
    expect(darkNative || schemes(style).length === 2).toBe(true);
  });
});
