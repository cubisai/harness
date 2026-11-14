import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT_LIMITS, findRemoteUrls, parseKitManifest, validateKitDir, type KitManifest } from "../src/main/design/kit-schema";
import { tempDir } from "./helpers";

/** The manifest a minimal kit writes, with one component and one composition. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kitId: "acme",
    name: "Acme",
    version: "1.0.0",
    contractVersion: "1.0",
    compat: { themes: ["*"], migratesFrom: [] },
    components: [
      {
        name: "Button",
        ui: "button",
        snippet: '<button type="button" data-ui="button">Save</button>',
      },
      {
        name: "Toolbar",
        ui: "toolbar",
        kind: "composition",
        snippet: '<div data-ui="toolbar"><button type="button" data-ui="button">Save</button></div>',
      },
    ],
    ...overrides,
  };
}

/** A minimal valid kit on disk. `overrides` replaces whole files (`null` leaves one out). */
function writeKit(dir: string, overrides: Record<string, string | null> = {}): string {
  const files: Record<string, string> = {
    "index.md": "---\ntype: design-kit\nname: Acme\n---\n# Acme\n",
    "DESIGN.md": "# Acme\n\nFlat, quiet, one accent.\n",
    "tokens.css": ":root {\n  --color-bg: #ffffff;\n  --color-text: #111111;\n}\n",
    "ui.css": '[data-ui="button"] {\n  padding: 8px 12px;\n}\n\n[data-ui="toolbar"] {\n  display: flex;\n}\n',
    "components.json": JSON.stringify(manifest(), null, 2),
  };
  for (const [name, text] of Object.entries({ ...files, ...overrides })) {
    if (text === null) continue;
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  return dir;
}

const kitDir = (overrides: Record<string, string | null> = {}): string => writeKit(tempDir(), overrides);

/** The errors of a refused kit, for a `toContain` style check. */
function errorsOf(result: ReturnType<typeof validateKitDir>): string[] {
  return result.ok ? [] : result.errors;
}

/** The errors of a refused manifest, for a `toContain` style check. */
function parseErrors(overrides: Record<string, unknown>): string[] {
  const text = JSON.stringify(manifest(overrides));
  const result = parseKitManifest(text);
  return result.ok ? [] : result.errors;
}

/** One component of the minimal manifest, changed. */
function firstComponent(patch: Record<string, unknown>): Record<string, unknown> {
  const components = manifest().components as Record<string, unknown>[];
  return { components: [{ ...components[0], ...patch }, components[1]] };
}

describe("validateKitDir", () => {
  it("passes a minimal kit, defaulting kind and props", () => {
    const result = validateKitDir(kitDir());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [button, toolbar] = result.manifest.components;
    expect(button?.kind).toBe("component");
    expect(toolbar?.kind).toBe("composition");
    expect(button?.props).toEqual([]);
  });

  it.each(["index.md", "DESIGN.md", "tokens.css", "ui.css", "components.json"])("reports a missing %s", (name) => {
    const errors = errorsOf(validateKitDir(kitDir({ [name]: null })));
    expect(errors.join("\n")).toContain(`${name}: required file is missing`);
  });

  it("reports an index.md without type: design-kit", () => {
    const errors = errorsOf(validateKitDir(kitDir({ "index.md": "---\ntype: design-style\n---\n" })));
    expect(errors.join("\n")).toContain("index.md");
    expect(errors.join("\n")).toContain("design-kit");
  });

  it("reports a kitId that is not the expected one", () => {
    const errors = errorsOf(validateKitDir(kitDir(), "other"));
    expect(errors.join("\n")).toContain('kitId "acme" does not match "other"');
  });

  it("reports tokens.css without --color-bg", () => {
    const errors = errorsOf(validateKitDir(kitDir({ "tokens.css": ":root {\n  --color-text: #111111;\n}\n" })));
    expect(errors.join("\n")).toContain("tokens.css: must define --color-bg:");
  });

  it("reports a ui.js over the limit", () => {
    const errors = errorsOf(validateKitDir(kitDir({ "ui.js": `//${"x".repeat(KIT_LIMITS.uiJsBytes)}\n` })));
    expect(errors.join("\n")).toContain("ui.js");
    expect(errors.join("\n")).toContain(String(KIT_LIMITS.uiJsBytes));
  });

  it("reports a file type no kit may hold", () => {
    const dir = kitDir({ "tool.exe": "MZ" });
    expect(errorsOf(validateKitDir(dir)).join("\n")).toContain("tool.exe");
  });

  it("reports a symlink, when the platform lets one be made", () => {
    const dir = kitDir();
    try {
      symlinkSync(join(dir, "tokens.css"), join(dir, "linked.css"));
    } catch {
      return; // Windows may refuse; nothing to check there.
    }
    expect(errorsOf(validateKitDir(dir)).join("\n")).toContain("linked.css");
  });

  it("reports a folder deeper than the limit", () => {
    const deep = Array.from({ length: KIT_LIMITS.maxDepth + 2 }, (_, i) => `d${i}`).join("/");
    const dir = kitDir({ [`${deep}/x.css`]: "" });
    expect(errorsOf(validateKitDir(dir)).join("\n")).toContain(`deeper than ${KIT_LIMITS.maxDepth}`);
  });

  it("reports a declared theme with no folder", () => {
    const compat = { themes: ["*", "dark"], migratesFrom: [] };
    const errors = errorsOf(validateKitDir(kitDir({ "components.json": JSON.stringify(manifest({ compat })) })));
    expect(errors.join("\n")).toContain('theme "dark" has no themes/dark/tokens.css');
  });

  it("accepts a declared theme whose tokens.css is there", () => {
    const compat = { themes: ["dark"], migratesFrom: [] };
    const dir = kitDir({
      "components.json": JSON.stringify(manifest({ compat })),
      "themes/dark/tokens.css": ":root {\n  --color-bg: #111111;\n  --color-text: #f5f5f5;\n}\n",
    });
    expect(validateKitDir(dir).ok).toBe(true);
  });

  it("reports a component ui.css does not style", () => {
    // Both are kind component, so both need a selector; only the button has one.
    const components = (manifest().components as Record<string, unknown>[]).map((c) => ({ ...c, kind: "component" }));
    const dir = kitDir({ "components.json": JSON.stringify(manifest({ components })), "ui.css": '[data-ui="button"] { padding: 8px; }\n' });
    expect(errorsOf(validateKitDir(dir)).join("\n")).toContain('[data-ui="toolbar"]');
  });

  it("accepts single quoted and bare selectors", () => {
    const css = "[data-ui='button'] { padding: 8px; }\n[data-ui=toolbar] { display: flex; }\n";
    expect(validateKitDir(kitDir({ "ui.css": css })).ok).toBe(true);
  });

  it("reports a block with a script tag", () => {
    const dir = kitDir({ "blocks/card.html": '<div data-ui="button">x</div>\n<script>alert(1)</script>\n' });
    expect(errorsOf(validateKitDir(dir)).join("\n")).toContain("blocks/card.html");
  });

  it("reports a block with an onclick handler", () => {
    const dir = kitDir({ "blocks/card.html": '<div data-ui="button" onclick="go()">x</div>\n' });
    expect(errorsOf(validateKitDir(dir)).join("\n")).toContain("blocks/card.html");
  });

  it("reports javascript: in a snippet", () => {
    const components = manifest().components as Record<string, unknown>[];
    const bad = [{ ...components[0], snippet: '<a href="javascript:go()" data-ui="button">x</a>' }, components[1]];
    const errors = errorsOf(validateKitDir(kitDir({ "components.json": JSON.stringify(manifest({ components: bad })) })));
    expect(errors.join("\n")).toContain("javascript:");
  });

  it("collects every problem, not just the first", () => {
    const errors = errorsOf(validateKitDir(kitDir({ "DESIGN.md": null, "tokens.css": ":root {}\n" })));
    expect(errors.join("\n")).toContain("DESIGN.md: required file is missing");
    expect(errors.join("\n")).toContain("tokens.css: must define --color-bg:");
  });

  it("refuses a folder that is not there without throwing", () => {
    const missing = join(tempDir(), "nope");
    expect(() => validateKitDir(missing)).not.toThrow();
    expect(validateKitDir(missing).ok).toBe(false);
  });
});

describe("parseKitManifest", () => {
  const parse = (text: string): string[] => {
    const result = parseKitManifest(text);
    return result.ok ? [] : result.errors;
  };

  it("accepts the minimal manifest and applies its defaults", () => {
    const result = parseKitManifest(JSON.stringify(manifest()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const typed: KitManifest = result.manifest;
    expect(typed.components[0]?.kind).toBe("component");
    expect(typed.components[0]?.props).toEqual([]);
  });

  it("reports bad JSON", () => {
    const errors = parse("{ nope");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("JSON");
  });

  it("reports an oversize file before parsing it", () => {
    const errors = parse(`{"pad":"${"x".repeat(KIT_LIMITS.manifestBytes)}"}`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("over");
  });

  it("reports a duplicate ui", () => {
    const components = manifest().components as Record<string, unknown>[];
    const errors = parseErrors({ components: [components[0], { ...components[1], ui: "button" }] });
    expect(errors.join("\n")).toContain('already uses data-ui="button"');
  });

  it("reports a duplicate prop", () => {
    const prop = { name: "size", label: "Size", type: "text", default: "md" };
    const errors = parseErrors(firstComponent({ props: [prop, prop] }));
    expect(errors.join("\n")).toContain('two props named "size"');
  });

  it("reports a choice prop without options", () => {
    const props = [{ name: "size", label: "Size", type: "choice" }];
    expect(parseErrors(firstComponent({ props })).join("\n")).toContain('choice prop "size"');
  });

  it("reports a default that is not one of the options", () => {
    const props = [{ name: "size", label: "Size", type: "choice", options: ["sm", "lg"], default: "md" }];
    expect(parseErrors(firstComponent({ props })).join("\n")).toContain('default "md"');
  });

  it("reports options on a boolean", () => {
    const props = [{ name: "busy", label: "Busy", type: "boolean", options: ["yes"], default: true }];
    expect(parseErrors(firstComponent({ props })).join("\n")).toContain("must not have options");
  });

  it("reports a snippet without its data-ui", () => {
    expect(parseErrors(firstComponent({ snippet: "<button>Save</button>" })).join("\n")).toContain('data-ui="button"');
  });

  it("reports a prop named ui", () => {
    const props = [{ name: "ui", label: "UI", type: "text", default: "x" }];
    expect(parseErrors(firstComponent({ props })).join("\n")).toContain("ui");
  });

  it("reports a bad version string", () => {
    expect(parseErrors({ version: "1.0" }).join("\n")).toContain("version");
  });
});

describe("findRemoteUrls", () => {
  it.each([
    'background: url(https://x.io/a.png);',
    '@import "https://x.io/a.css";',
    '<img src="//cdn.x.io/a.png">',
    "see https://x.io for details",
    "<link href='https://x.io/a.css'>",
  ])("finds a remote reference in %j", (text) => {
    expect(findRemoteUrls(text)).toHaveLength(1);
  });

  it("finds each one among several, without repeats", () => {
    const found = findRemoteUrls('url(https://x.io/a.png) @import "https://x.io/a.css" <img src="//cdn.x.io/a.png"> https://x.io');
    expect(found).toHaveLength(4);
  });

  it.each(['xmlns="http://www.w3.org/2000/svg"', "// a comment", "url(fonts/a.woff2)", "/** @import url(local.css) */"])("ignores %j", (text) => {
    expect(findRemoteUrls(text)).toEqual([]);
  });
});

describe("an SVG in a kit", () => {
  it("is held to the same rules as a block", () => {
    const dir = tempDir();
    writeKit(dir);
    mkdirSync(join(dir, "blocks"), { recursive: true });
    writeFileSync(join(dir, "blocks", "bad.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
    const result = validateKitDir(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("bad.svg");
  });

  it("passes when it only carries its namespace", () => {
    const dir = tempDir();
    writeKit(dir);
    mkdirSync(join(dir, "blocks"), { recursive: true });
    writeFileSync(join(dir, "blocks", "ok.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
    expect(validateKitDir(dir).ok).toBe(true);
  });
});
