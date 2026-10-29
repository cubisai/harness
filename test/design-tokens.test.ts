import { describe, expect, it } from "vitest";
import { parseTokens, setToken } from "../src/main/design/tokens";

// Shaped like resources/design-systems/clean/tokens.css: a header comment, one
// top-level :root grouped by comments, a dark media query, a reduced-motion one.
const TOKENS_CSS = `/* Fixture: CubiQ-shaped design system tokens. */
:root {
  color-scheme: light dark;

  /* Color (light) */
  --color-bg: #ffffff;
  --color-text: #18181b;
  --color-primary: #2563eb;

  /* Radius */
  --radius-sm: 6px;

  /* Elevation */
  --shadow-1: 0 1px 2px rgb(0 0 0 / 0.06);
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #0f0f11;
    --color-text: #f4f4f5;
  }
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast: 0ms;
    --duration: 0ms;
  }
}
`;

const LIGHT_ONLY = `:root {
  --color-bg: #ffffff;
}
`;

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce) {\n  :root {\n    --duration-fast: 0ms;\n    --duration: 0ms;\n  }\n}";

/** A flat name → token view of the parsed groups. */
function byName(css: string) {
  return new Map(parseTokens(css).flatMap((g) => g.tokens).map((t) => [t.name, t] as const));
}

describe("parseTokens", () => {
  it("titles groups from their comments, in source order", () => {
    expect(parseTokens(TOKENS_CSS).map((g) => g.title)).toEqual(["Color", "Radius", "Elevation"]);
  });

  it("reads light values and only the dark overrides the dark :root has", () => {
    const tokens = byName(TOKENS_CSS);
    expect(tokens.get("--color-bg")).toEqual({ name: "--color-bg", light: "#ffffff", dark: "#0f0f11" });
    expect(tokens.get("--color-text")).toEqual({ name: "--color-text", light: "#18181b", dark: "#f4f4f5" });
    expect(tokens.get("--color-primary")!.dark).toBeNull();
    expect(tokens.get("--radius-sm")!.dark).toBeNull();
  });

  it("keeps slashes and parentheses in a value intact", () => {
    expect(byName(TOKENS_CSS).get("--shadow-1")!.light).toBe("0 1px 2px rgb(0 0 0 / 0.06)");
  });

  it("skips color-scheme and any non-custom property", () => {
    const names = parseTokens(TOKENS_CSS).flatMap((g) => g.tokens).map((t) => t.name);
    expect(names).not.toContain("color-scheme");
    expect(names.every((n) => n.startsWith("--"))).toBe(true);
  });

  it("returns an empty list for garbage", () => {
    expect(parseTokens("not css at all {{{")).toEqual([]);
    expect(parseTokens("")).toEqual([]);
  });
});

describe("setToken", () => {
  it("changes only the light declaration, byte-for-byte", () => {
    const out = setToken(TOKENS_CSS, "--color-bg", "light", "#000000");
    expect(out).toBe(TOKENS_CSS.replace("--color-bg: #ffffff;", "--color-bg: #000000;"));
    expect(byName(out).get("--color-bg")!.dark).toBe("#0f0f11");
  });

  it("replaces an existing dark value", () => {
    const out = setToken(TOKENS_CSS, "--color-text", "dark", "#eeeeee");
    expect(out).toBe(TOKENS_CSS.replace("--color-text: #f4f4f5;", "--color-text: #eeeeee;"));
  });

  it("inserts a dark override into the dark :root when the token has none", () => {
    const out = setToken(TOKENS_CSS, "--color-primary", "dark", "#60a5fa");
    expect(out).toContain("--color-text: #f4f4f5;\n    --color-primary: #60a5fa;\n  }");
    expect(byName(out).get("--color-primary")!.dark).toBe("#60a5fa");
  });

  it("appends a dark block when the file has none", () => {
    const out = setToken(LIGHT_ONLY, "--color-bg", "dark", "#0f0f11");
    expect(out).toBe(
      `${LIGHT_ONLY}\n@media (prefers-color-scheme: dark) {\n  :root {\n    --color-bg: #0f0f11;\n  }\n}\n`,
    );
  });

  it("leaves the reduced-motion block untouched", () => {
    expect(setToken(TOKENS_CSS, "--shadow-1", "light", "none")).toContain(REDUCED_MOTION);
  });

  it("throws for an invalid value", () => {
    expect(() => setToken(TOKENS_CSS, "--color-bg", "light", "red; }")).toThrow("Invalid token value.");
    expect(() => setToken(TOKENS_CSS, "--color-bg", "light", "   ")).toThrow("Invalid token value.");
  });

  it("throws for an unknown token", () => {
    expect(() => setToken(TOKENS_CSS, "--nope", "light", "#000000")).toThrow("Unknown token --nope.");
  });

  it("round-trips: parsing the result shows the new value", () => {
    const out = setToken(TOKENS_CSS, "--radius-sm", "light", "10px");
    expect(byName(out).get("--radius-sm")!.light).toBe("10px");
  });
});
