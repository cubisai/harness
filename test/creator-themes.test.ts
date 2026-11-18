import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareTheme, readThemeFiles, validateThemeConfig } from "../src/main/creator/themes";
import type { DesignSystemInfo } from "../src/main/design/systems";
import { parseTokens } from "../src/main/design/tokens";
import { validateProposal } from "../src/main/extensions/manifest";
import { tempDir } from "./helpers";

const CSS = ":root {\n  --color-bg: #ffffff;\n  --color-text: #111111;\n  --color-primary: #333333;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    --color-bg: #111111;\n    --color-text: #eeeeee;\n  }\n}\n";
function base() {
  const dir = tempDir();
  writeFileSync(join(dir, "tokens.css"), CSS);
  writeFileSync(join(dir, "DESIGN.md"), "# Base\n");
  const system: DesignSystemInfo = { id: "project:base", name: "Base", description: "", swatches: [], source: "projectFolder", tokensCss: join(dir, "tokens.css"), designMd: join(dir, "DESIGN.md") };
  return { dir, system, resolve: (id: string) => id === system.id ? system : null };
}
const config = { title: "Paper", base: "project:base", tokens: [{ name: "--color-bg", scheme: "light", value: "#f5f5ef" }] };

describe("Creator page themes", () => {
  it("prepares an immutable reviewed config without writing a destination and keeps schemes independent", () => {
    const b = base();
    const draft = prepareTheme("paper", config, b.resolve);
    const files = readThemeFiles(draft, b.resolve);
    const css = files.find((f) => f.path === "tokens.css")!.content.toString();
    const bg = parseTokens(css).flatMap((g) => g.tokens).find((t) => t.name === "--color-bg")!;
    expect(bg).toMatchObject({ light: "#f5f5ef", dark: "#111111" });
    expect(readFileSync(b.system.tokensCss!, "utf8")).toBe(CSS);
    expect(existsSync(join(b.dir, "paper"))).toBe(false);
    expect(validateProposal(draft, { scope: { kind: "project", projectId: "p" } }).ok).toBe(true);
    expect(validateProposal(draft, { scope: { kind: "global" } }).ok).toBe(false);
  });

  it.each([
    { ...config, surprise: true },
    { ...config, base: "../escape" },
    { ...config, tokens: [] },
    { ...config, tokens: [{ name: "--unknown", scheme: "light", value: "red" }] },
    { ...config, tokens: [{ name: "--color-bg", scheme: "system", value: "red" }] },
    { ...config, tokens: [...config.tokens, ...config.tokens] },
    ...["red; color: blue", "url(https://example.com)", "uRl (x)", "u\\72l(x)", "var(--missing)", "var(--color-bg)", "/*x*/ red", "red\n", "var(--color-text)"].map((value) => ({ ...config, tokens: [{ name: "--color-bg", scheme: "light", value }, ...(value === "var(--color-text)" ? [{ name: "--color-text", scheme: "light", value: "var(--color-bg)" }] : [])] })),
  ])("refuses bad config atomically: %j", (input) => {
    expect(() => validateThemeConfig(input, CSS)).toThrow();
  });

  it("refuses changed source, unknown base and symlink files", () => {
    const b = base();
    const draft = prepareTheme("paper", config, b.resolve);
    writeFileSync(b.system.tokensCss!, CSS + "/* changed */");
    expect(() => readThemeFiles(draft, b.resolve)).toThrow(/changed after review/);
    expect(() => prepareTheme("paper", config, () => null)).toThrow(/available/);
    const other = base();
    mkdirSync(join(other.dir, "fonts"));
    const outside = join(tempDir(), "font.woff2");
    writeFileSync(outside, "not a font");
    symlinkSync(outside, join(other.dir, "fonts", "bad.woff2"));
    other.system.fontFiles = [join(other.dir, "fonts", "bad.woff2")];
    expect(() => prepareTheme("paper", config, other.resolve)).toThrow(/symlink|regular/);
  });
});
