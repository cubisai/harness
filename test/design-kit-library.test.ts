import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addComposition, applyKitEdit, applyTokenOverrides, brandEdits, cleanCompositionHtml, compositionWarnings, forkKitSystem, freeFolder, manifestIn, partCounts, partSample, partsUsingToken, saveKitDraft, saveSystemCopy, seedKitDraft, systemSlug } from "../src/main/design/kit-library";
import { migratePage, parseMigrations } from "../src/main/design/kit-migrate";
import { parseKitManifest, validateKitDir } from "../src/main/design/kit-schema";
import { listDesignSystems, listKitSystems, materializeSystem } from "../src/main/design/systems";
import { applyChange } from "../src/main/design/source-edit";
import { ignoredChange } from "../src/main/design/watch";
import { parseDesignMutation } from "../src/main/design/documents";
import { tempDir } from "./helpers";

const FOUNDATION = join(process.cwd(), "resources", "design-kits", "foundation");
const foundation = () => listKitSystems(FOUNDATION)[0]!;
const flat = () => {
  const dir = tempDir();
  writeFileSync(join(dir, "DESIGN.md"), "# Flat");
  writeFileSync(join(dir, "tokens.css"), ":root {\n  --color-bg: #fff;\n  --color-text: #111;\n  --color-primary: #123456;\n}\n");
  return { id: "style:flat", name: "Flat", description: "A flat one", swatches: ["#fff"], source: "style" as const, designMd: join(dir, "DESIGN.md"), tokensCss: join(dir, "tokens.css") };
};

describe("slugs and folders", () => {
  it("makes a folder name from a person's name for it", () => {
    expect(systemSlug("Glacier (Team) ✨")).toBe("glacier-team");
    expect(systemSlug("Café Noir")).toBe("cafe-noir");
    expect(systemSlug("✨✨")).toBe("");
  });
  it("never takes an existing folder", () => {
    const root = tempDir();
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "a-2"));
    expect(freeFolder(root, "a")).toBe("a-3");
    expect(freeFolder(root, "b")).toBe("b");
  });
});

describe("saving a theme", () => {
  it("keeps a flat style flat, with the page's values in its tokens", () => {
    const project = tempDir();
    const saved = saveSystemCopy(flat(), project, "My Theme", { "--color-primary": "#ff0000", "--nope": "1px" });
    expect(saved.id).toBe("project:my-theme");
    expect(saved.kit).toBeUndefined();
    expect(readFileSync(saved.tokensCss!, "utf8")).toContain("--color-primary: #ff0000;");
    expect(readFileSync(saved.tokensCss!, "utf8")).not.toContain("--nope");
    expect(listDesignSystems(project).map((s) => s.name)).toEqual(["My Theme"]);
  });

  it("keeps a kit copy a theme of that kit, passing the kit validator with its themes left behind", () => {
    const project = tempDir();
    const saved = saveSystemCopy(foundation(), project, "Brand");
    expect(saved.kit?.id).toBe("foundation");
    const verdict = validateKitDir(saved.kit!.dir);
    expect(verdict.ok ? [] : verdict.errors).toEqual([]);
    expect(manifestIn(saved.kit!.dir)?.compat.themes).toEqual([]);
    expect(existsSync(join(saved.kit!.dir, "blocks"))).toBe(true);
    // And it materializes like any kit.
    const dest = tempDir();
    materializeSystem(saved, dest);
    expect(existsSync(join(dest, "ui.css"))).toBe(true);
    expect(readFileSync(join(dest, ".system"), "utf8")).toBe("project:brand");
  });

  it("gives two saves of one name two folders, and refuses a name with nothing in it", () => {
    const project = tempDir();
    saveSystemCopy(flat(), project, "Same");
    expect(saveSystemCopy(flat(), project, "Same").id).toBe("project:same-2");
    expect(() => saveSystemCopy(flat(), project, "✨")).toThrow(/name/);
  });

  it("keeps a name from adding a frontmatter field", () => {
    const project = tempDir();
    const saved = saveSystemCopy(flat(), project, "x\ntype: nope");
    expect(saved.name).toBe("x type: nope");
  });

  it("changes dark too when a token has a dark value", () => {
    const css = ":root {\n  --color-primary: #111;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    --color-primary: #222;\n  }\n}\n";
    const out = applyTokenOverrides(css, { "--color-primary": "#333" });
    expect(out.css.match(/#333/g)).toHaveLength(2);
    expect(out.applied).toEqual(["--color-primary"]);
  });

  it("copies a bundled kit once on its first edit", () => {
    const project = tempDir();
    const first = forkKitSystem(foundation(), project);
    expect(first.id).toBe("project:foundation-custom");
    writeFileSync(first.tokensCss!, `${readFileSync(first.tokensCss!, "utf8")}\n/* edited */\n`);
    expect(readFileSync(forkKitSystem(foundation(), project).tokensCss!, "utf8")).toContain("edited");
    expect(readFileSync(join(FOUNDATION, "tokens.css"), "utf8")).not.toContain("edited");
  });
});

describe("kit drafts", () => {
  it("starts a new kit from Foundation under its own id, and saves it to the project", () => {
    const draft = join(tempDir(), "kit");
    const project = tempDir();
    expect(seedKitDraft(foundation(), draft, { kitId: "projects-kit", name: "Projects kit" })).toBe(true);
    const base = manifestIn(FOUNDATION);
    const result = saveKitDraft(draft, project, "projects-kit", { markNew: true, base });
    expect(result.ok).toBe(true);
    const saved = listDesignSystems(project).find((s) => s.id === "project:projects-kit");
    expect(saved?.kit?.id).toBe("projects-kit");
    expect(manifestIn(saved!.kit!.dir)?.components.some((c) => c.status === "new")).toBe(false);
  });

  it("keeps an existing draft, so later prompts refine it", () => {
    const draft = join(tempDir(), "kit");
    seedKitDraft(foundation(), draft);
    writeFileSync(join(draft, "tokens.css"), `${readFileSync(join(draft, "tokens.css"), "utf8")}\n/* mine */\n`);
    expect(seedKitDraft(foundation(), draft)).toBe(false);
    expect(readFileSync(join(draft, "tokens.css"), "utf8")).toContain("mine");
  });

  it("marks what a save adds as new, and says what it added", () => {
    const draft = join(tempDir(), "kit");
    const project = tempDir();
    seedKitDraft(foundation(), draft, { kitId: "k", name: "K" });
    const path = join(draft, "components.json");
    const m = JSON.parse(readFileSync(path, "utf8")) as { components: Record<string, unknown>[] };
    m.components.push({ name: "Progress Card", ui: "progress-card", snippet: '<div data-ui="progress-card"></div>', props: [] });
    writeFileSync(path, JSON.stringify(m));
    writeFileSync(join(draft, "ui.css"), `${readFileSync(join(draft, "ui.css"), "utf8")}\n[data-ui="progress-card"] { padding: 16px; }\n`);
    const result = saveKitDraft(draft, project, "k", { markNew: true, base: manifestIn(FOUNDATION) });
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.diff.added).toEqual(["progress-card"]);
    expect(manifestIn(join(project, ".agents/design-systems/k"))?.components.find((c) => c.ui === "progress-card")?.status).toBe("new");
  });

  it("refuses a broken draft with its reasons, leaving what was there", () => {
    const draft = join(tempDir(), "kit");
    const project = tempDir();
    seedKitDraft(foundation(), draft, { kitId: "k", name: "K" });
    expect(saveKitDraft(draft, project, "k").ok).toBe(true);
    const path = join(draft, "components.json");
    const m = JSON.parse(readFileSync(path, "utf8")) as { components: Record<string, unknown>[] };
    m.components.push({ name: "Broken", ui: "broken", snippet: "<div>no attribute</div>", props: [] });
    writeFileSync(path, JSON.stringify(m));
    const result = saveKitDraft(draft, project, "k");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/broken/);
    expect(manifestIn(join(project, ".agents/design-systems/k"))?.components.some((c) => c.ui === "broken")).toBe(false);
  });

  it("leaves a board page or a stray file behind, so neither reaches the project", () => {
    const draft = join(tempDir(), "kit");
    const project = tempDir();
    seedKitDraft(foundation(), draft, { kitId: "k", name: "K" });
    writeFileSync(join(draft, "board.html"), "<p>board</p>");
    writeFileSync(join(draft, ".DS_Store"), "x");
    expect(saveKitDraft(draft, project, "k").ok).toBe(true);
    expect(existsSync(join(project, ".agents/design-systems/k/board.html"))).toBe(false);
  });
});

describe("compositions", () => {
  const kit = () => {
    const dir = join(tempDir(), "kit");
    cpSync(FOUNDATION, dir, { recursive: true });
    return dir;
  };
  it("adds a block and an entry, with the editor's ids off and no script", () => {
    const dir = kit();
    const { ui } = addComposition(dir, "Hero Row", '<section data-agent-id="el-1" onclick="x()"><h1>Hi</h1><script>bad()</script></section>');
    expect(ui).toBe("hero-row");
    const html = readFileSync(join(dir, "blocks", "hero-row.html"), "utf8");
    expect(html).toContain('data-ui="hero-row"');
    expect(html).not.toMatch(/agent-id|onclick|script/);
    const parsed = parseKitManifest(readFileSync(join(dir, "components.json"), "utf8"));
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.manifest.components.find((c) => c.ui === "hero-row")?.kind).toBe("composition");
    const verdict = validateKitDir(dir);
    expect(verdict.ok ? [] : verdict.errors).toEqual([]);
  });
  it("won't take a name it already has, a remote link, or a block too big for a snippet", () => {
    const dir = kit();
    addComposition(dir, "Row", "<div>a</div>");
    expect(() => addComposition(dir, "row", "<div>b</div>")).toThrow(/already/);
    expect(() => addComposition(dir, "Pic", '<img src="https://x.test/a.png">')).toThrow(/network/);
    expect(() => addComposition(dir, "Big", `<div>${"x".repeat(5000)}</div>`)).toThrow(/too large/);
  });
  it("says what won't carry over", () => {
    expect(compositionWarnings('<div data-ui="card">x</div>')).toEqual([]);
    expect(compositionWarnings('<div style="color:red" class="a">x</div>').length).toBe(2);
    expect(cleanCompositionHtml('<a onmouseover="x" href="#">y</a>')).toBe('<a href="#">y</a>');
  });
});

describe("what a change reaches", () => {
  it("counts parts on a page", () => {
    expect(partCounts('<a data-ui="button"></a><b data-ui="button"></b><i data-ui=card></i>')).toEqual(new Map([["button", 2], ["card", 1]]));
  });
  it("finds the parts whose rules read a token", () => {
    const css = '[data-ui="button"] { color: var(--color-primary); }\n[data-ui="card"] { color: var(--color-text); }\n@media (x) { [data-ui="tab"] { fill: var(--color-primary, red); } }';
    expect([...partsUsingToken(css, "--color-primary")].sort()).toEqual(["button", "tab"]);
  });
  it("rewrites a brand's roles and the text on it, in both schemes, only for tokens the kit has", () => {
    const css = ":root {\n  --color-primary: #000;\n  --color-on-primary: #fff;\n  --color-text: #111;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    --color-primary: #eee;\n  }\n}\n";
    const edits = brandEdits(css, "#ffee00");
    expect(edits.map((e) => e.name)).toEqual(["--color-primary", "--color-on-primary"]);
    expect(edits[0]).toEqual({ name: "--color-primary", light: "#ffee00", dark: "#ffee00" });
    expect(edits[1]).toEqual({ name: "--color-on-primary", light: "#000000", dark: null });
  });
});

describe("hand edits to a kit", () => {
  const kit = (css: string) => {
    const dir = tempDir();
    writeFileSync(join(dir, "ui.css"), css);
    writeFileSync(
      join(dir, "components.json"),
      JSON.stringify({ kitId: "k", name: "K", version: "1.0.0", contractVersion: "1.0", compat: { themes: [], migratesFrom: [] }, components: [{ name: "Button", ui: "button", props: [{ name: "variant", label: "Variant", type: "choice", options: ["solid", "ghost"], default: "solid" }], snippet: '<button data-ui="button">Go</button>' }, { name: "Card", ui: "card", props: [], snippet: '<div data-ui="card"></div>' }] }),
    );
    return dir;
  };
  const props = (dir: string) => manifestIn(dir)!.components[0]!.props;
  it("adds a variant with a copy of its rules, renamed", () => {
    const dir = kit('[data-ui="button"][data-variant="solid"] { color: red; }\n[data-ui="button"][data-variant="ghost"] { color: blue; }\n');
    applyKitEdit(dir, { kind: "addVariant", ui: "button", name: "Brand", from: "solid" });
    expect(props(dir)[0]!.options).toEqual(["solid", "ghost", "brand"]);
    const css = readFileSync(join(dir, "ui.css"), "utf8");
    expect(css).toContain('[data-ui="button"][data-variant="brand"] { color: red; }');
    expect(css).toContain('[data-variant="solid"]');
  });
  it("sends a variant with no rules of its own to the agent", () => {
    const dir = kit('[data-ui="button"] { color: red; }\n');
    expect(() => applyKitEdit(dir, { kind: "addVariant", ui: "button", name: "x", from: "solid" })).toThrow(/agent/);
  });
  it("removes a variant and moves the default off it, but never the last one", () => {
    const dir = kit("");
    applyKitEdit(dir, { kind: "removeVariant", ui: "button", name: "solid" });
    expect(props(dir)[0]).toMatchObject({ options: ["ghost"], default: "ghost" });
    expect(() => applyKitEdit(dir, { kind: "removeVariant", ui: "button", name: "ghost" })).toThrow(/at least one/);
  });
  it("adds and removes a prop, refusing what the contract refuses", () => {
    const dir = kit("");
    applyKitEdit(dir, { kind: "addProp", ui: "button", prop: { name: "Icon Side", label: "Icon side", type: "choice", options: ["left", "right"], default: "left" } });
    expect(props(dir).map((p) => p.name)).toEqual(["variant", "icon-side"]);
    expect(() => applyKitEdit(dir, { kind: "addProp", ui: "button", prop: { name: "x", label: "X", type: "choice" } })).toThrow();
    expect(props(dir).map((p) => p.name)).not.toContain("x");
    applyKitEdit(dir, { kind: "removeProp", ui: "button", name: "icon-side" });
    expect(props(dir).map((p) => p.name)).toEqual(["variant"]);
  });
  it("removes a component, but never the last, and clears a new mark", () => {
    const dir = kit("");
    applyKitEdit(dir, { kind: "removeComponent", ui: "card" });
    expect(manifestIn(dir)!.components.map((c) => c.ui)).toEqual(["button"]);
    expect(() => applyKitEdit(dir, { kind: "removeComponent", ui: "button" })).toThrow(/at least one/);
  });
});

describe("part samples", () => {
  const part = { ui: "button", snippet: '<button data-ui="button">A</button><button data-ui="button">B</button>', props: [{ name: "variant", options: ["solid", "ghost"] }, { name: "size", options: ["sm", "md"] }] };
  it("draws a matrix of variants by sizes, one instance each", () => {
    const html = partSample(part, "system", { matrix: true });
    expect(html.match(/data-variant="solid"/g)).toHaveLength(2);
    expect(html.match(/data-variant="ghost"/g)).toHaveLength(2);
    expect(html).toContain('href="system/ui.css"');
  });
  it("draws one instance with the props given", () => {
    const html = partSample(part, "kit", { props: { variant: "ghost", disabled: "true", size: "false" } });
    expect(html).toContain('href="kit/ui.css"');
    expect(html).toMatch(/data-variant="ghost"/);
    expect(html).toMatch(/data-disabled=""/);
    expect(html).not.toMatch(/data-size/);
  });
});

describe("moving a page to another kit", () => {
  const manifest = (kitId: string, components: unknown[]) => {
    const parsed = parseKitManifest(JSON.stringify({ kitId, name: kitId, version: "1.0.0", contractVersion: "1.0", compat: { themes: [], migratesFrom: [] }, components }));
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return parsed.manifest;
  };
  const from = manifest("a", [
    { name: "Button", ui: "button", props: [{ name: "variant", label: "V", type: "choice", options: ["contained", "text"] }, { name: "tone", label: "T", type: "choice", options: ["danger"] }], snippet: '<button data-ui="button"></button>' },
    { name: "Chip", ui: "chip", props: [], snippet: '<span data-ui="chip"></span>' },
    { name: "Fab", ui: "fab", props: [], snippet: '<button data-ui="fab"></button>' },
    { name: "Card", ui: "card", props: [], snippet: '<div data-ui="card"><h3 data-part="title"></h3></div>' },
  ]);
  const to = manifest("b", [
    { name: "Button", ui: "button", props: [{ name: "variant", label: "V", type: "choice", options: ["solid", "text"] }], snippet: '<button data-ui="button"></button>' },
    { name: "Badge", ui: "badge", props: [], snippet: '<span data-ui="badge"></span>' },
    { name: "Card", ui: "card", props: [], snippet: '<div data-ui="card"><header data-part="header"></header></div>' },
  ]);
  const page = `<!doctype html><html><head><title>t</title></head><body>
  <button data-ui="button" data-variant="contained" data-tone="danger" data-track="x">Go</button>
  <button data-ui="button" data-variant="text">Plain</button>
  <span data-ui="chip">New</span>
  <button data-ui="fab">+</button>
  <div data-ui="card"><h3 data-part="title">T</h3></div>
</body></html>`;

  it("renames by table, drops props the target lacks, and flags what it can't move", () => {
    const plan = migratePage(page, from, to, { chip: "badge" });
    expect(plan.html).toContain('<span data-ui="badge">New</span>');
    expect(plan.html).toContain('<button data-ui="button" data-track="x">Go</button>');
    expect(plan.html).toContain('data-variant="text"');
    expect(plan.html).toContain('<button data-ui="fab">+</button>');
    expect(plan.same).toBe(3);
    expect(plan.renamed).toEqual([{ from: "chip", to: "badge", count: 1 }]);
    expect(plan.unsupported).toEqual([{ ui: "fab", name: "Fab", count: 1 }]);
    expect(plan.droppedProps.map((d) => `${d.prop}=${d.value}`)).toEqual(["variant=contained", "tone=danger"]);
    expect(plan.review).toEqual([{ ui: "card", name: "Card", count: 1 }]);
  });

  it("changes no other byte of the page", () => {
    const plan = migratePage(page, from, to, { chip: "badge" });
    const rest = (s: string) => s.replace(/ data-variant="contained"| data-tone="danger"/g, "").replace('data-ui="chip"', 'data-ui="badge"');
    expect(plan.html).toBe(rest(page));
  });

  it("leaves a flat page alone", () => {
    const plain = "<!doctype html><html><body><h1 class=x>Hi</h1></body></html>";
    const plan = migratePage(plain, null, to, {});
    expect(plan.changed).toBe(false);
    expect(plan.html).toBe(plain);
  });

  it("ignores a bad migrations file", () => {
    expect(parseMigrations("{nope")).toEqual({});
    expect(parseMigrations(null)).toEqual({});
    expect(parseMigrations('{"aliases":{"a":"b","c":1}}')).toEqual({ a: "b" });
  });

  it("is a change the page editor can make, but one IPC can't ask for", () => {
    expect(applyChange("<html><body>a</body></html>", { locator: { tag: "html", path: [] } }, { kind: "replaceDocument", html: "<html><body>b</body></html>" }, () => "el-1").html).toBe("<html><body>b</body></html>");
    expect(parseDesignMutation({ operationId: "o", documentId: "d", baseRevision: 1, target: { id: "x" }, transactionId: "t", change: { kind: "replaceDocument", html: "<p>" } })).toBeNull();
  });
});

describe("the watcher", () => {
  it("doesn't reload the canvas for its own hidden previews", () => {
    expect(ignoredChange(".preview-page.html")).toBe(true);
    expect(ignoredChange(".preview/system/tokens.css")).toBe(true);
    expect(ignoredChange("index.html")).toBe(false);
  });
});
