// Tests for the design-system guard scripts/design-check.mjs. Every check runs
// on tiny in-memory file arrays; only the final smoke test touches the tree.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyAllowlist,
  checkDocValues,
  checkLiteralColors,
  checkRouter,
  checkSkills,
  checkThemeDrift,
  checkTokenCollisions,
  checkTokenRefs,
  checkTokensDoc,
  checkTypeScale,
  formatIssue,
  runChecks,
  SEVERITY,
  TYPE_SCALE_PX,
  type DesignAllowlistEntry,
  type DesignFile,
  type DesignIssue,
} from "../scripts/design-check.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const f = (path: string, text: string): DesignFile => ({ path, text });

describe("SEVERITY and TYPE_SCALE_PX", () => {
  it("maps every code to its severity", () => {
    expect(SEVERITY["design/literal-color"]).toBe("error");
    expect(SEVERITY["design/type-offscale"]).toBe("error");
    expect(SEVERITY["design/token-missing"]).toBe("error");
    expect(SEVERITY["design/token-stale"]).toBe("error");
    expect(SEVERITY["design/token-collision"]).toBe("warning");
    expect(SEVERITY["design/theme-drift"]).toBe("warning");
    expect(SEVERITY["design/doc-value"]).toBe("warning");
    expect(SEVERITY["design/skill-ref-unknown"]).toBe("error");
    expect(SEVERITY["design/skill-invalid"]).toBe("error");
    expect(SEVERITY["design/doc-structure"]).toBe("error");
    expect(SEVERITY["design/allowlist-unused"]).toBe("warning");
    expect(SEVERITY["design/component-missing"]).toBe("error");
    expect(Object.isFrozen(SEVERITY)).toBe(true);
  });

  it("lists the type scale", () => {
    expect(TYPE_SCALE_PX).toContain(13);
    expect(TYPE_SCALE_PX).not.toContain(26);
  });
});

describe("checkLiteralColors", () => {
  it("allows a literal in a :root token declaration only", () => {
    const css = ":root {\n  --primary: #0b0d10;\n}\n.x { color: #ffffff; }\n.beam { --w: #fff; }\n.a { background: url(#abc); }\n";
    const issues = checkLiteralColors([f("a.css", css)]);
    expect(issues.map((i) => i.line)).toEqual([4, 5]);
    expect(issues.every((i) => i.code === "design/literal-color")).toBe(true);
    expect(issues[0]!.value).toBe("#ffffff");
    expect(issues[1]!.value).toBe("#fff");
  });

  it("flags rgb()/hsl() calls outside a :root declaration", () => {
    const css = ":root { --x: rgb(1 2 3); }\n.x { color: rgb( 255 255 255 / 0.5 ); }\n.y { color: hsl(200 50% 50%); }\n";
    const issues = checkLiteralColors([f("a.css", css)]);
    expect(issues.map((i) => i.value)).toEqual(["rgb( 255 255 255 / 0.5 )", "hsl(200 50% 50%)"]);
  });

  it("only counts TS literals inside quoted segments, and skips comment lines", () => {
    const tsx = 'const a = { style: { color: "#0a84ff" } };\n// #fff\nconst b = `hsl(1 2% 3%)`;\n';
    const issues = checkLiteralColors([f("a.tsx", tsx)]);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ line: 1, value: "#0a84ff" });
    expect(issues[1]).toMatchObject({ line: 3 });
  });
});

describe("checkTypeScale", () => {
  it("accepts on-scale sizes and ignores units/var/calc", () => {
    const css = ":root { --font: 13px; }\n.a { font-size: 13px; }\n.d { font-size: 1.2em; }\n.e { font-size: var(--s); }\n.g { font-size: calc(13px * 2); }\n";
    expect(checkTypeScale([f("a.css", css)])).toEqual([]);
  });

  it("flags an off-scale font-size", () => {
    const issues = checkTypeScale([f("a.css", ".b { font-size: 26px; }\n")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "design/type-offscale", line: 1, value: "26px" });
  });

  it("flags the size in a font shorthand even with var() family", () => {
    const issues = checkTypeScale([f("a.css", ".c { font: 600 26px/1.2 var(--font); }\n")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "design/type-offscale", line: 1, value: "26px" });
  });

  it("flags TS fontSize numbers and string px", () => {
    const tsx = 'const s = { fontSize: 26 };\nconst t = { fontSize: "13px" };\nconst u = { fontSize: 13 };\n';
    const issues = checkTypeScale([f("a.tsx", tsx)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "design/type-offscale", line: 1 });
  });
});

describe("checkTokenRefs", () => {
  it("flags an undeclared var with no fallback, but not with one", () => {
    const css = ":root { --ok: 1; }\n.a { color: var(--nope); }\n.b { color: var(--nope, 0); }\n.c { color: var(--ok); }\n";
    const issues = checkTokenRefs([f("a.css", css)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "design/token-missing", line: 2, value: "var(--nope)" });
  });

  it("counts JS-written vars from quoted strings", () => {
    const css = ".a { width: var(--zoom); }\n";
    const tsx = 'el.style.setProperty("--zoom", "1");\nconst x = "var(--zoom)";\n';
    expect(checkTokenRefs([f("a.css", css), f("a.tsx", tsx)])).toEqual([]);
  });

  it("flags a token declared only in dark blocks", () => {
    const css = ':root { --a: 1; }\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) { --b: 2; }\n}\n:root[data-theme="dark"] { --a: 3; }\n';
    const issues = checkTokenRefs([f("a.css", css)]);
    expect(issues.filter((i) => i.value === "--b")).toHaveLength(1);
    expect(issues.some((i) => i.value === "--a")).toBe(false);
  });
});

describe("checkTokenCollisions", () => {
  it("warns on a duplicate declaration in one rule", () => {
    const issues = checkTokenCollisions([f("a.css", ".x { --a: 1; --a: 2; }\n")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "design/token-collision", severity: "warning", line: 1 });
  });

  it("warns when two token names normalise the same", () => {
    const issues = checkTokenCollisions([f("a.css", ":root { --foo-bar: 1; --foobar: 2; }\n")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "design/token-collision", severity: "warning" });
  });
});

describe("checkThemeDrift", () => {
  it("reports differing and one-sided dark tokens", () => {
    const css = '@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) { --a: #111111; --c: 1; }\n}\n:root[data-theme="dark"] { --a: #222222; --d: 2; }\n';
    const issues = checkThemeDrift([f("a.css", css)]);
    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.value)).toEqual(["--a", "--c", "--d"]);
    expect(issues.every((i) => i.code === "design/theme-drift")).toBe(true);
  });
});

describe("checkDocValues", () => {
  it("checks DESIGN.md and other docs but not tokens.md", () => {
    const files = [f("DESIGN.md", "use #fff here\n"), f("docs/design/tokens.md", "#fff\n"), f("docs/design/other.md", "use #abc\n")];
    const issues = checkDocValues(files);
    expect(issues.map((i) => i.file)).toEqual(["DESIGN.md", "docs/design/other.md"]);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });
});

describe("checkSkills", () => {
  const valid = f(".claude/skills/foo/SKILL.md", "---\nname: foo\ndescription: Does a thing\n---\nSee docs/design/README.md and DESIGN.md\n");
  const known = [f("docs/design/README.md", "# R"), f("DESIGN.md", "x")];

  it("accepts valid frontmatter and known references", () => {
    expect(checkSkills([valid, ...known])).toEqual([]);
  });

  it("flags missing frontmatter", () => {
    const issues = checkSkills([f(".claude/skills/foo/SKILL.md", "name: foo\ndescription: d\n")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("design/skill-invalid");
  });

  it("flags 500+ lines", () => {
    const body = `---\nname: foo\ndescription: d\n---\n${Array.from({ length: 500 }, () => "line").join("\n")}\n`;
    const issues = checkSkills([f(".claude/skills/foo/SKILL.md", body)]);
    expect(issues.some((i) => i.code === "design/skill-invalid" && i.message.includes("lines"))).toBe(true);
  });

  it("flags an unknown doc reference", () => {
    const bad = f(".claude/skills/foo/SKILL.md", "---\nname: foo\ndescription: d\n---\nSee docs/design/missing.md\n");
    const issues = checkSkills([bad, ...known]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "design/skill-ref-unknown", value: "docs/design/missing.md" });
  });
});

describe("checkRouter", () => {
  it("accepts a README with all four headings", () => {
    const readme = f("docs/design/README.md", "## Read Order\nx\n## Design Highlights\ny\n## Do\nz\n## Avoid\nw\n");
    expect(checkRouter([readme])).toEqual([]);
  });

  it("reports each missing heading", () => {
    const readme = f("docs/design/README.md", "## Read Order\nx\n");
    const issues = checkRouter([readme]);
    expect(issues).toHaveLength(3);
    expect(issues.every((i) => i.code === "design/doc-structure")).toBe(true);
  });

  it("reports a missing README", () => {
    const issues = checkRouter([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toBe("docs/design/README.md is missing");
  });
});

describe("checkTokensDoc", () => {
  const appCss = f("src/renderer/src/styles/app.css", "a{}");
  const gen = (css: string) => `generated:${css.length}`;

  it("accepts a matching tokens doc", () => {
    expect(checkTokensDoc([appCss, f("docs/design/tokens.md", "generated:3")], gen)).toEqual([]);
  });

  it("flags a mismatching tokens doc", () => {
    const issues = checkTokensDoc([appCss, f("docs/design/tokens.md", "stale")], gen);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "design/token-stale", file: "docs/design/tokens.md" });
  });

  it("flags a missing tokens doc", () => {
    const issues = checkTokensDoc([appCss], gen);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("design/token-stale");
  });
});

describe("applyAllowlist", () => {
  const base = (over: Partial<DesignIssue> = {}): DesignIssue => ({
    severity: "error",
    code: "design/literal-color",
    file: "a.css",
    line: 1,
    message: "m",
    value: "rgb( 11 13 16 / 0.07 )",
    ...over,
  });

  it("matches across whitespace differences", () => {
    const allow: DesignAllowlistEntry[] = [{ code: "design/literal-color", file: "a.css", value: "rgb(11 13 16 / 0.07)", reason: "r" }];
    const res = applyAllowlist([base()], allow);
    expect(res.issues).toEqual([]);
    expect(res.unused).toEqual([]);
  });

  it("reports unused entries as warnings", () => {
    const allow: DesignAllowlistEntry[] = [{ code: "design/literal-color", file: "b.css", value: "#fff", reason: "r" }];
    const res = applyAllowlist([base()], allow);
    expect(res.issues).toHaveLength(1);
    expect(res.unused).toHaveLength(1);
    expect(res.unused[0]).toMatchObject({ code: "design/allowlist-unused", severity: "warning", file: "scripts/design-allowlist.json" });
  });
});

describe("formatIssue", () => {
  it("renders severity, code, location and message", () => {
    expect(formatIssue({ severity: "error", code: "design/x", file: "a.css", line: 3, message: "hi" })).toBe("error design/x a.css:3 hi");
  });

  it("appends a value when present", () => {
    expect(formatIssue({ severity: "warning", code: "design/x", file: "a.css", line: 3, message: "hi", value: "v" })).toBe("warning design/x a.css:3 hi [v]");
  });
});

describe("runChecks", () => {
  it("applies the allowlist and sorts by file/line/code", () => {
    const readme = f("docs/design/README.md", "## Read Order\n## Design Highlights\n## Do\n## Avoid\n");
    const files = [f("b.css", ".b { color: #fff; }\n"), f("a.css", ".a { color: #000; }\n"), f("docs/design/tokens.md", ""), readme];
    const raw = runChecks(files, { generateTokensMd: () => "" });
    expect(raw.map((i) => i.file)).toEqual(["a.css", "b.css"]);
    const allow: DesignAllowlistEntry[] = raw.map((i) => ({ code: i.code, file: i.file, value: i.value ?? "", reason: "r" }));
    expect(runChecks(files, { generateTokensMd: () => "", allowlist: allow })).toEqual([]);
  });
});

describe("CLI smoke", () => {
  it("prints a JSON array on --json", () => {
    const res = spawnSync(process.execPath, ["scripts/design-check.mjs", "--json"], { cwd: repoRoot, encoding: "utf8" });
    const parsed = JSON.parse(String(res.stdout));
    expect(Array.isArray(parsed)).toBe(true);
  });
});
