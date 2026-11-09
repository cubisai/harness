import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forkSystem, listDesignStyles, listDesignSystems, listKitSystems, materializeSystem, type DesignStyleInfo } from "../src/main/design/systems";
import { tempDir } from "./helpers";

const MANIFEST = {
  kitId: "acme",
  name: "Acme",
  version: "1.2.0",
  contractVersion: "1.0",
  compat: { themes: ["*"], migratesFrom: [] },
  components: [{ name: "Button", ui: "button", snippet: '<button data-ui="button">Go</button>' }],
};

function writeKit(dir: string, manifest: object = MANIFEST): string {
  mkdirSync(join(dir, "blocks"), { recursive: true });
  mkdirSync(join(dir, "themes", "dusk"), { recursive: true });
  writeFileSync(join(dir, "index.md"), "---\ntype: design-kit\nname: Acme\ndescription: A test kit.\n---\n");
  writeFileSync(join(dir, "DESIGN.md"), "kit design");
  writeFileSync(join(dir, "tokens.css"), ":root { --color-bg: #ffffff; --color-text: #000000; }");
  writeFileSync(join(dir, "ui.css"), '[data-ui="button"] { padding: 0; }');
  writeFileSync(join(dir, "ui.js"), "void 0;");
  writeFileSync(join(dir, "components.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "blocks", "hero.html"), '<section data-ui="hero"></section>');
  writeFileSync(join(dir, "themes", "dusk", "tokens.css"), ":root { --color-bg: #111111; --color-text: #eeeeee; }");
  return dir;
}

function style(dir: string): DesignStyleInfo {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "DESIGN.md"), "style design");
  writeFileSync(join(dir, "tokens.css"), ":root { --color-bg: #fafafa; --color-text: #111111; }");
  return {
    id: "style:paper",
    name: "Paper",
    description: "A style.",
    swatches: ["#fff"],
    source: "style",
    designMd: join(dir, "DESIGN.md"),
    tokensCss: join(dir, "tokens.css"),
    tags: [],
    modes: [],
    platform: "any",
  };
}

const find = (list: ReturnType<typeof listKitSystems>, id: string) => {
  const hit = list.find((s) => s.id === id);
  if (!hit) throw new Error(`No system ${id}`);
  return hit;
};

describe("listKitSystems", () => {
  it("lists the kit, its themes and, with a * compat, every style", () => {
    const list = listKitSystems(writeKit(tempDir()), [style(tempDir())]);
    expect(list.map((s) => s.id)).toEqual(["kit:acme", "kit:acme/dusk", "kit:acme/paper"]);
    expect(list.every((s) => s.source === "kit" && s.kit?.id === "acme" && s.kit.version === "1.2.0")).toBe(true);
    expect(find(list, "kit:acme/dusk").facets?.theme).toBe("dark");
    expect(find(list, "kit:acme/paper").name).toBe("Paper");
  });

  it("offers no styles without a * compat", () => {
    const manifest = { ...MANIFEST, compat: { themes: ["dusk"], migratesFrom: [] } };
    const list = listKitSystems(writeKit(tempDir(), manifest), [style(tempDir())]);
    expect(list.map((s) => s.id)).toEqual(["kit:acme", "kit:acme/dusk"]);
  });

  it("lists nothing for a missing folder, a bad manifest or a missing ui.css", () => {
    expect(listKitSystems(join(tempDir(), "gone"))).toEqual([]);
    expect(listKitSystems(writeKit(tempDir(), { kitId: "Bad Id" }))).toEqual([]);
    const noCss = writeKit(tempDir());
    writeFileSync(join(noCss, "components.json"), "{");
    expect(listKitSystems(noCss)).toEqual([]);
  });
});

describe("materializeSystem with a kit", () => {
  it("copies the parts beside the tokens, then reports no change", () => {
    const dest = join(tempDir(), "system");
    const [kit] = listKitSystems(writeKit(tempDir()));
    expect(materializeSystem(kit!, dest)).toBe(true);
    expect(readdirSync(dest).sort()).toEqual([".kit", ".system", "DESIGN.md", "blocks", "components.json", "tokens.css", "ui.css", "ui.js"]);
    expect(readFileSync(join(dest, "blocks", "hero.html"), "utf8")).toContain("hero");
    expect(readFileSync(join(dest, ".system"), "utf8")).toBe("kit:acme");
    expect(materializeSystem(kit!, dest)).toBe(false);
  });

  it("uses a style's rules and tokens over the kit's, and keeps the kit's rules as KIT.md", () => {
    const dest = join(tempDir(), "system");
    const themed = find(listKitSystems(writeKit(tempDir()), [style(tempDir())]), "kit:acme/paper");
    materializeSystem(themed, dest);
    expect(readFileSync(join(dest, "DESIGN.md"), "utf8")).toBe("style design");
    expect(readFileSync(join(dest, "KIT.md"), "utf8")).toBe("kit design");
    expect(readFileSync(join(dest, "tokens.css"), "utf8")).toContain("#fafafa");
    expect(existsSync(join(dest, "ui.css"))).toBe(true);
  });

  it("switching a theme swaps tokens and leaves the parts alone", () => {
    const dest = join(tempDir(), "system");
    const list = listKitSystems(writeKit(tempDir()), [style(tempDir())]);
    materializeSystem(find(list, "kit:acme"), dest);
    const parts = readFileSync(join(dest, "ui.css"), "utf8");
    materializeSystem(find(list, "kit:acme/dusk"), dest);
    expect(readFileSync(join(dest, "tokens.css"), "utf8")).toContain("#111111");
    expect(readFileSync(join(dest, "ui.css"), "utf8")).toBe(parts);
  });

  it("removes every kit file when the thread goes back to a flat style", () => {
    const dest = join(tempDir(), "system");
    const paper = style(tempDir());
    materializeSystem(find(listKitSystems(writeKit(tempDir()), [paper]), "kit:acme/paper"), dest);
    expect(materializeSystem(paper, dest)).toBe(true);
    expect(readdirSync(dest).sort()).toEqual([".system", "DESIGN.md", "tokens.css"]);
    expect(materializeSystem(paper, dest)).toBe(false);
  });

  it("a flat style never removes files it didn't bring, with no kit marker", () => {
    const dest = join(tempDir(), "system");
    mkdirSync(join(dest, "blocks"), { recursive: true });
    writeFileSync(join(dest, "ui.css"), "mine");
    writeFileSync(join(dest, "blocks", "a.html"), "mine");
    materializeSystem(style(tempDir()), dest);
    expect(readFileSync(join(dest, "ui.css"), "utf8")).toBe("mine");
    expect(readFileSync(join(dest, "blocks", "a.html"), "utf8")).toBe("mine");
  });

  it("drops a part and a block the next version no longer has", () => {
    const dest = join(tempDir(), "system");
    const dir = writeKit(tempDir());
    materializeSystem(listKitSystems(dir)[0]!, dest);
    rmSync(join(dir, "ui.js"));
    rmSync(join(dir, "blocks", "hero.html"));
    writeFileSync(join(dir, "blocks", "cta.html"), '<section data-ui="cta"></section>');
    expect(materializeSystem(listKitSystems(dir)[0]!, dest)).toBe(true);
    expect(existsSync(join(dest, "ui.js"))).toBe(false);
    expect(readdirSync(join(dest, "blocks"))).toEqual(["cta.html"]);
  });

  it("refuses to fork a kit, so nothing bundled is ever written in place", () => {
    const [kit] = listKitSystems(writeKit(tempDir()));
    expect(() => forkSystem(kit!, tempDir())).toThrow("can't be edited");
  });
});

describe("a project kit", () => {
  it("is listed with its kit from .agents/design-systems, and a folder with a foreign components.json stays flat", () => {
    const project = tempDir();
    const systems = join(project, ".agents", "design-systems");
    writeKit(join(systems, "ours"));
    writeFileSync(join(systems, "ours", "index.md"), "---\ntype: design-system\nname: Ours\n---\n");
    const flat = join(systems, "flat");
    mkdirSync(flat, { recursive: true });
    writeFileSync(join(flat, "index.md"), "---\ntype: design-system\nname: Flat\n---\n");
    writeFileSync(join(flat, "DESIGN.md"), "flat");
    writeFileSync(join(flat, "ui.css"), "x");
    writeFileSync(join(flat, "components.json"), JSON.stringify({ $schema: "https://ui.shadcn.com/schema.json", style: "default" }));
    const list = listDesignSystems(project);
    expect(list.find((s) => s.id === "project:ours")?.kit?.id).toBe("acme");
    expect(list.find((s) => s.id === "project:flat")?.kit).toBeUndefined();
  });
});

describe("the bundled library", () => {
  it("still lists 32 flat styles, none with a kit", () => {
    const styles = listDesignStyles(join(process.cwd(), "resources", "design-styles"), join(process.cwd(), "resources", "design-fonts"));
    expect(styles).toHaveLength(32);
    expect(styles.every((s) => s.kit === undefined)).toBe(true);
  });
});
