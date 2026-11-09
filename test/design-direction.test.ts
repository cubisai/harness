import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { listDesignStyles, materializeSystem, pickFromShortlist, styleIndex, tokenFacets } from "../src/main/design/systems";
import { Service } from "../src/main/service";
import { readDirection, SURFACES } from "../src/shared/direction";
import { tierOf } from "../src/shared/tiers";
import { catalog, closeAfter, tempDir } from "./helpers";

function fakeDriver(): AgentDriver & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "fake",
    label: "Fake",
    defaultModel: "fake-1",
    capabilities: SAFE_DEFAULTS,
    skillsDelivery: { mode: "none" },
    skillCallPrefix: "skilled:",
    models: () => [{ id: "fake-1", label: "Fake 1" }],
    prompts,
    async runTurn(input: TurnInput) {
      prompts.push(input.prompt);
    },
  };
}

/** A style library with two styles (one with a font) and a font pack. */
function library(): { styles: string; fonts: string } {
  const root = tempDir();
  const styles = join(root, "styles");
  const fonts = join(root, "fonts");
  mkdirSync(fonts, { recursive: true });
  writeFileSync(join(fonts, "riso-display.woff2"), "FONT");
  const style = (folder: string, extra: string) => {
    mkdirSync(join(styles, folder), { recursive: true });
    writeFileSync(join(styles, folder, "index.md"), `---\ntype: design-style\nname: ${folder} name\ndescription: ${folder} look\ntags: print, warm\nmodes: persuade, experience\nplatform: web\n${extra}---\n`);
    writeFileSync(join(styles, folder, "DESIGN.md"), `# ${folder}\n`);
    writeFileSync(join(styles, folder, "tokens.css"), `:root { --color-bg: #fff; }\n`);
  };
  style("riso", "fonts: riso-display.woff2, missing.woff2\n");
  style("swiss", "");
  mkdirSync(join(styles, "broken"), { recursive: true });
  writeFileSync(join(styles, "broken", "index.md"), "---\ntype: design-style\n---\n");
  return { styles, fonts };
}

function setup() {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const driver = fakeDriver();
  const service = new Service(store, () => catalog(), [driver], () => {});
  const lib = library();
  service.setDesignStylesDir(lib.styles, lib.fonts);
  const project = store.addProject(tempDir());
  return { store, service, driver, project, lib };
}

describe("tokenFacets", () => {
  const facetsOf = (bg: string, extra = "") => tokenFacets(`:root { --color-bg: ${bg}; ${extra} }\n`);

  it("reads the theme from the base background", () => {
    expect(facetsOf("#0A0A0A")?.theme).toBe("dark");
    expect(facetsOf("#FFFFFF")?.theme).toBe("light");
    expect(facetsOf("#fff")?.theme).toBe("light");
    expect(facetsOf("rgb(14 59 46)")?.theme).toBe("dark");
  });

  it("ignores a dark override after the first @media and flags it as a dark pair", () => {
    const css = ":root { --color-bg: #FFFFFF; }\n@media (prefers-color-scheme: dark) { :root { --color-bg: #000; } }";
    expect(tokenFacets(css)).toMatchObject({ theme: "light", darkPair: true });
  });

  it("reads the display family from --font-display", () => {
    expect(facetsOf("#fff", `--font-display: "Bodoni Moda", Georgia, "Times New Roman", serif;`)?.display).toBe("serif");
    expect(facetsOf("#fff", `--font-display: "Geist Mono", ui-monospace, monospace;`)?.display).toBe("mono");
    expect(facetsOf("#fff", `--font-display: "Onest", system-ui, sans-serif;`)?.display).toBe("sans");
  });

  it("reads the corner shape from --radius-md, soft when it's missing", () => {
    expect(facetsOf("#fff", "--radius-md: 0px;")?.shape).toBe("sharp");
    expect(facetsOf("#fff", "--radius-md: 6px;")?.shape).toBe("soft");
    expect(facetsOf("#fff", "--radius-md: 14px;")?.shape).toBe("round");
    expect(facetsOf("#fff")?.shape).toBe("soft");
  });

  it("returns null without a --color-bg", () => {
    expect(tokenFacets(":root { --color-text: #000; }")).toBeNull();
  });
});

describe("style library", () => {
  it("lists well-formed styles with tags, modes, platform and the fonts that exist", () => {
    const { lib } = setup();
    const styles = listDesignStyles(lib.styles, lib.fonts);
    expect(styles.map((s) => s.id)).toEqual(["style:riso", "style:swiss"]);
    expect(styles[0]).toMatchObject({ name: "riso name", source: "style", tags: ["print", "warm"], modes: ["persuade", "experience"], platform: "web" });
    expect(styles[0]!.fontFiles).toEqual([join(lib.fonts, "riso-display.woff2")]);
    expect(styles[1]!.fontFiles).toBeUndefined();
    expect(styleIndex(styles)).toBe("riso: riso look [print, warm; persuade/experience; web]\nswiss: swiss look [print, warm; persuade/experience; web]");
  });

  it("materializes a style's fonts into system/fonts and removes them on a switch to a system without fonts", () => {
    const { lib } = setup();
    const [riso, swiss] = listDesignStyles(lib.styles, lib.fonts);
    const dest = join(tempDir(), "system");
    materializeSystem(riso!, dest);
    expect(readFileSync(join(dest, "fonts", "riso-display.woff2"), "utf8")).toBe("FONT");
    materializeSystem(swiss!, dest);
    expect(existsSync(join(dest, "fonts", "riso-display.woff2"))).toBe(false);
    expect(readFileSync(join(dest, ".system"), "utf8")).toBe("style:swiss");
  });
});

describe("Auto design threads", () => {
  it("start on Auto when no system (or a gone one) is picked; an explicit pick and chat threads are unchanged", () => {
    const { service, project } = setup();
    expect(service.createThread(project.id, undefined, "design").designSystem).toBe("auto");
    expect(service.createThread(project.id, undefined, "design", "style:swiss").designSystem).toBe("style:swiss");
    expect(service.createThread(project.id, undefined, "design", "clean").designSystem).toBe("auto");
    expect(service.createThread(project.id).designSystem).toBeUndefined();
  });

  it("tell the agent to set a direction until it does, then put the chosen style (and its fonts) in system/", async () => {
    const { service, driver, project } = setup();
    const thread = service.createThread(project.id, undefined, "design");
    await service.send({ threadId: thread.id, text: "a landing page" });
    expect(driver.prompts[0]).toContain("call design_set_direction once");
    expect(driver.prompts[0]).not.toContain("Prototype tier");
    const root = service.designRoot(thread.id)!;
    expect(existsSync(join(root, "system", "DESIGN.md"))).toBe(false);

    const reply = service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "riso" });
    expect(reply).toContain("Direction: page, Persuade, tier working.");
    expect(reply).toContain("riso name");
    expect(reply).toContain("system/fonts/");
    expect(reply).toContain("Prototype tier: Working.");
    expect(readFileSync(join(root, "system", "DESIGN.md"), "utf8")).toBe("# riso\n");
    expect(existsSync(join(root, "system", "fonts", "riso-display.woff2"))).toBe(true);
    expect(readFileSync(join(root, ".tier"), "utf8")).toBe("working");

    await service.send({ threadId: thread.id, text: "make it bolder" });
    expect(driver.prompts[1]).not.toContain("design_set_direction");
    expect(driver.prompts[1]).not.toContain("Prototype tier");
  });

  it("refuse an unknown style with the valid ids, and store a valid direction", () => {
    const { service, store, project } = setup();
    const thread = service.createThread(project.id, undefined, "design");
    expect(() => service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "nope" })).toThrow(
      'Unknown style "nope". Pick one of: riso, swiss.',
    );
    service.setDesignDirection(thread.id, { surface: "screen", mode: "operate", tier: "real-app", style: "style:swiss" });
    const saved = store.getThread(thread.id);
    expect(saved.designDirection).toEqual({ surface: "screen", mode: "operate", tier: "real-app", style: "style:swiss" });
    expect(tierOf(saved)).toBe("real-app");
  });

  it("follow the project's own DESIGN.md whatever style the agent names", () => {
    const { service, project } = setup();
    writeFileSync(join(project.path, "DESIGN.md"), "# Ours\n");
    const thread = service.createThread(project.id, undefined, "design");
    const reply = service.setDesignDirection(thread.id, { surface: "page", mode: "read", tier: "working", style: "riso" });
    expect(reply).toContain("Project");
    expect(readFileSync(join(service.designRoot(thread.id)!, "system", "DESIGN.md"), "utf8")).toBe("# Ours\n");
  });

  it("tell a new Auto thread which styles the project used recently", () => {
    const { service, driver, project } = setup();
    const first = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(first.id, { surface: "page", mode: "persuade", tier: "working", style: "riso" });
    const second = service.createThread(project.id, undefined, "design");
    return service.send({ threadId: second.id, text: "another page" }).then(() => {
      expect(driver.prompts[0]).toContain("Recently used in this project: riso;");
    });
  });

  it("give a legacy row the migration missed (no system stored) no fixed fallback palette", async () => {
    const { service, store, driver, project } = setup();
    const legacy = service.createThread(project.id, undefined, "design");
    store.setDesignSystem(legacy.id, null);
    await service.send({ threadId: legacy.id, text: "x" });
    expect(driver.prompts[0]).not.toContain("design_set_direction");
    expect(driver.prompts[0]).toContain("Prototype tier: Working.");
    expect(existsSync(join(service.designRoot(legacy.id)!, "system", "DESIGN.md"))).toBe(false);
  });
});

describe("More styles", () => {
  /** A service on the real bundled style library. */
  function realSetup() {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const service = new Service(store, () => catalog(), [fakeDriver()], () => {});
    const RESOURCES = join(__dirname, "..", "resources");
    service.setDesignStylesDir(join(RESOURCES, "design-styles"), join(RESOURCES, "design-fonts"));
    service.setDesignPatternsDir(join(RESOURCES, "design-patterns"));
    service.setDesignIconsDir(join(RESOURCES, "design-icons"));
    const project = store.addProject(tempDir());
    return { store, service, project };
  }

  it("needs a built design, then copies 3 different styles that fit the surface and asks for one variant each", () => {
    const { service, project } = realSetup();
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "riso-print" });
    expect(() => service.prepareMoreStyles(thread.id)).toThrow("Build the design first.");
    const root = service.designRoot(thread.id)!;
    writeFileSync(join(root, "index.html"), "<h1>x</h1>");
    const { names, text } = service.prepareMoreStyles(thread.id);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
    expect(names).not.toContain("Riso Print");
    const ids = [...text.matchAll(/`variant-([a-z0-9-]+)\.html`/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(existsSync(join(root, "styles", id, "DESIGN.md"))).toBe(true);
      expect(existsSync(join(root, "styles", id, "tokens.css"))).toBe(true);
      expect(text).toContain(`link \`styles/${id}/tokens.css\``);
    }
    expect(text).toContain("Leave index.html and system/ as they are.");
  });

  it("keeps a deck to deck styles", () => {
    const { service, project } = realSetup();
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { surface: "deck", mode: "read", tier: "working", style: "data-report" });
    writeFileSync(join(service.designRoot(thread.id)!, "index.html"), "<section></section>");
    expect(service.prepareMoreStyles(thread.id).names).toEqual(["Chalk Keynote"]);
  });

  it("promoting a style's variant moves an Auto thread's direction to that style", () => {
    const { service, store, project } = realSetup();
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "riso-print" });
    const root = service.designRoot(thread.id)!;
    writeFileSync(join(root, "index.html"), "<h1>old</h1>");
    writeFileSync(join(root, "variant-swiss-grid.html"), "<h1>swiss</h1>");
    service.promoteDesignVariant(thread.id, "variant-swiss-grid.html");
    expect(store.getThread(thread.id).designDirection?.style).toBe("style:swiss-grid");
    expect(store.getThread(thread.id).designSystem).toBe("auto");
  });

  it("copies the surface's pattern notes into system/ and asks for a brief", () => {
    const { service, project } = realSetup();
    const thread = service.createThread(project.id, undefined, "design");
    const reply = service.setDesignDirection(thread.id, { surface: "workspace", mode: "operate", tier: "working", style: "control-room" });
    const root = service.designRoot(thread.id)!;
    expect(readFileSync(join(root, "system", "patterns.md"), "utf8")).toContain("# Workspace patterns");
    expect(reply).toContain("system/patterns.md");
    expect(reply).toContain("brief.md");
    service.setDesignDirection(thread.id, { surface: "mobile", mode: "operate", tier: "working", style: "control-room" });
    expect(readFileSync(join(root, "system", "patterns.md"), "utf8")).toContain("# Mobile patterns");
  });

  it("copies the AI-parts notes beside the patterns on any surface but slides", () => {
    const { service, project } = realSetup();
    const thread = service.createThread(project.id, undefined, "design");
    const reply = service.setDesignDirection(thread.id, { surface: "screen", mode: "operate", tier: "working", style: "clean-inset" });
    const root = service.designRoot(thread.id)!;
    expect(readFileSync(join(root, "system", "ai-parts.md"), "utf8")).toContain("**Tool call card**");
    expect(reply).toContain("system/ai-parts.md");
    const deck = service.createThread(project.id, undefined, "design");
    expect(service.setDesignDirection(deck.id, { surface: "deck", mode: "persuade", tier: "working", style: "chalk-keynote" })).not.toContain("ai-parts");
  });

  it("copies the icon sprite into system/ and names it in the reply", () => {
    const { service, project } = realSetup();
    const thread = service.createThread(project.id, undefined, "design");
    const reply = service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "glacier" });
    const root = service.designRoot(thread.id)!;
    expect(readFileSync(join(root, "system", "icons.svg"), "utf8")).toContain('<symbol id="search"');
    expect(reply).toContain("system/icons.svg");
  });

  it("ships a sprite of stroked line icons without the stock AI-magic ones", () => {
    const sprite = readFileSync(join(__dirname, "..", "resources", "design-icons", "icons.svg"), "utf8");
    const ids = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(100);
    expect(ids).not.toContain("sparkles");
    expect(ids).not.toContain("rocket");
    for (const symbol of sprite.match(/<symbol id=[^>]*>/g) ?? []) expect(symbol).toContain('stroke="currentColor"');
  });

  it("ships pattern notes for every surface", () => {
    for (const s of SURFACES) expect(existsSync(join(__dirname, "..", "resources", "design-patterns", `${s}.md`))).toBe(true);
  });
});

describe("the bundled style library", () => {
  const RESOURCES = join(__dirname, "..", "resources");
  const styles = listDesignStyles(join(RESOURCES, "design-styles"), join(RESOURCES, "design-fonts"));

  it("loads every style folder, each with its declared fonts present and the tokens the guide relies on", () => {
    const folders = readdirSync(join(RESOURCES, "design-styles"), { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(styles).toHaveLength(folders.length);
    expect(styles.length).toBeGreaterThanOrEqual(20);
    for (const s of styles) {
      const index = readFileSync(join(RESOURCES, "design-styles", s.id.slice("style:".length), "index.md"), "utf8");
      const declared = /^fonts:\s*(.*)$/m.exec(index)?.[1]?.split(",").map((f) => f.trim()).filter(Boolean) ?? [];
      expect(s.fontFiles?.length ?? 0, `${s.id} fonts`).toBe(declared.length);
      const css = readFileSync(s.tokensCss!, "utf8");
      for (const token of ["--color-bg", "--color-text", "--color-primary", "--color-on-primary", "--font-sans", "--font-display", "--space-4", "--radius-md"]) {
        expect(css, `${s.id} ${token}`).toContain(`${token}:`);
      }
      for (const file of declared) expect(css, `${s.id} @font-face ${file}`).toContain(`url("fonts/${file}")`);
      expect(s.modes.length, `${s.id} modes`).toBeGreaterThan(0);
      expect(["web", "mobile", "deck", "any"], `${s.id} platform`).toContain(s.platform);
    }
  });

  // 940: 32 styles since the two product-UI styles (2026-10-28); ~29 tokens a line.
  it("keeps the index the direction tool carries under ~940 tokens", () => {
    expect(Math.ceil(Buffer.byteLength(styleIndex(styles)) / 3)).toBeLessThanOrEqual(940);
  });

  it("reads facets from every style's tokens.css, dark bases included", () => {
    for (const s of styles) expect(s.facets, s.id).toBeDefined();
    for (const id of ["arcade-cabinet", "zinc-console", "night-studio", "control-room"]) {
      expect(styles.find((s) => s.id === `style:${id}`)?.facets?.theme, id).toBe("dark");
    }
    expect(styles.find((s) => s.id === "style:swiss-grid")?.facets).toMatchObject({ theme: "light", darkPair: true, display: "sans", shape: "sharp" });
    expect(styles.find((s) => s.id === "style:atelier")?.facets?.display).toBe("serif");
    expect(styles.find((s) => s.id === "style:terminal")?.facets?.display).toBe("mono");
  });

  it("marks a dark style at the end of its index bracket", () => {
    const dark = {
      id: "style:night-studio",
      name: "Night Studio",
      description: "A dark studio look",
      swatches: [],
      source: "style" as const,
      designMd: "/tmp/DESIGN.md",
      tokensCss: "/tmp/tokens.css",
      tags: ["dark", "editorial"],
      modes: ["persuade"],
      platform: "web",
      facets: { theme: "dark" as const, darkPair: false, display: "sans" as const, shape: "soft" as const },
    };
    expect(styleIndex([dark])).toMatch(/; dark\]$/);
  });

  it("ships a license for every font in the pack", () => {
    const licenses = readFileSync(join(RESOURCES, "design-fonts", "LICENSES.md"), "utf8");
    const families = new Set(styles.flatMap((s) => [...readFileSync(s.tokensCss!, "utf8").matchAll(/font-family: "([^"]+)"/g)].map((m) => m[1]!)));
    for (const family of families) expect(licenses, family).toContain(`## ${family}`);
  });
});

describe("readDirection", () => {
  it("parses stored JSON and rejects anything malformed", () => {
    expect(readDirection('{"surface":"page","mode":"read","style":"style:riso","tier":"quick"}')).toEqual({ surface: "page", mode: "read", style: "style:riso", tier: "quick" });
    expect(readDirection('{"surface":"page","mode":"loud","style":"x","tier":"quick"}')).toBeNull();
    expect(readDirection("not json")).toBeNull();
    expect(readDirection(null)).toBeNull();
  });
});

/** A style library built for shortlists: four web styles, an operate one, and a slide one. */
function shortlistSetup() {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const driver = fakeDriver();
  const service = new Service(store, () => catalog(), [driver], () => {});
  const root = tempDir();
  const stylesDir = join(root, "styles");
  const fontsDir = join(root, "fonts");
  mkdirSync(fontsDir, { recursive: true });
  const style = (folder: string, modes: string, platform: string) => {
    mkdirSync(join(stylesDir, folder), { recursive: true });
    writeFileSync(join(stylesDir, folder, "index.md"), `---\ntype: design-style\nname: ${folder} name\ndescription: ${folder} look\ntags: test\nmodes: ${modes}\nplatform: ${platform}\n---\n`);
    writeFileSync(join(stylesDir, folder, "DESIGN.md"), `# ${folder}\n`);
    writeFileSync(join(stylesDir, folder, "tokens.css"), `:root { --color-bg: #fff; }\n`);
  };
  for (const folder of ["alpha", "beta", "gamma", "delta"]) style(folder, "persuade, experience", "web");
  style("quiet", "operate", "web");
  style("slides", "persuade, read", "deck");
  service.setDesignStylesDir(stylesDir, fontsDir);
  const project = store.addProject(tempDir());
  return { store, service, driver, project, stylesDir, fontsDir };
}

describe("style shortlist", () => {
  it("picks the same id from the same list and seed, and always the only id", () => {
    const first = pickFromShortlist(["a", "b", "c"], "thread-1");
    expect(pickFromShortlist(["a", "b", "c"], "thread-1")).toBe(first);
    expect(["a", "b", "c"]).toContain(first);
    expect(pickFromShortlist(["only"], "thread-1")).toBe("only");
  });

  it("favours the top pick at about half and still reaches the last one", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const id = pickFromShortlist(["a", "b", "c"], `t${i}`);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect((counts.get("a") ?? 0) / 400).toBeGreaterThan(0.4);
    expect((counts.get("a") ?? 0) / 400).toBeLessThan(0.6);
    expect(counts.get("c") ?? 0).toBeGreaterThan(0);
  });

  it("stores the given style unchanged when there are no alternates", () => {
    const { service, store, project } = shortlistSetup();
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "alpha" });
    expect(store.getThread(thread.id).designDirection?.style).toBe("style:alpha");
  });

  it("picks the same shortlist style each time on the same thread", () => {
    const { service, store, project } = shortlistSetup();
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "alpha" }, ["beta", "gamma"]);
    const once = store.getThread(thread.id).designDirection?.style;
    service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "alpha" }, ["beta", "gamma"]);
    expect(store.getThread(thread.id).designDirection?.style).toBe(once);
    expect(["style:alpha", "style:beta", "style:gamma"]).toContain(once);
  });

  it("varies the pick across parallel threads without leaving the shortlist", () => {
    const { service, store, project } = shortlistSetup();
    const stored: string[] = [];
    for (let i = 0; i < 30; i++) {
      const thread = service.createThread(project.id, undefined, "design");
      service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "alpha" }, ["beta", "gamma"]);
      stored.push(store.getThread(thread.id).designDirection?.style ?? "");
    }
    expect(new Set(stored).size).toBeGreaterThanOrEqual(2);
    for (const style of stored) expect(["style:alpha", "style:beta", "style:gamma"]).toContain(style);
  });

  it("says so when CubiQ picked off the shortlist, and says the style was the agent's without alternates", () => {
    const { service, store, project } = shortlistSetup();
    let shortlistReply = "";
    for (let i = 0; i < 40 && !shortlistReply; i++) {
      const thread = service.createThread(project.id, undefined, "design");
      const reply = service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "alpha" }, ["beta", "gamma"]);
      if (store.getThread(thread.id).designDirection?.style !== "style:alpha") shortlistReply = reply;
    }
    expect(shortlistReply).toContain("CubiQ picked it from your shortlist");
    const plain = service.createThread(project.id, undefined, "design");
    const reply = service.setDesignDirection(plain.id, { surface: "page", mode: "persuade", tier: "working", style: "alpha" });
    expect(reply).toContain("(the style you picked)");
  });

  it("ignores alternates that don't exist or don't fit the surface", () => {
    const { service, store, project } = shortlistSetup();
    const thread = service.createThread(project.id, undefined, "design");
    expect(() =>
      service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "alpha" }, ["nope", "slides"]),
    ).not.toThrow();
    expect(store.getThread(thread.id).designDirection?.style).toBe("style:alpha");
  });

  it("keeps only styles whose modes include the direction's mode", () => {
    const { service, store, project } = shortlistSetup();
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { surface: "page", mode: "operate", tier: "working", style: "alpha" }, ["quiet"]);
    expect(store.getThread(thread.id).designDirection?.style).toBe("style:quiet");
  });

  it("drops styles other threads used, and still picks when every candidate is recent", () => {
    const { service, store, project } = shortlistSetup();
    const a = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(a.id, { surface: "page", mode: "persuade", tier: "working", style: "alpha" });
    const b = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(b.id, { surface: "page", mode: "persuade", tier: "working", style: "alpha" }, ["beta"]);
    expect(store.getThread(b.id).designDirection?.style).toBe("style:beta");
    const c = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(c.id, { surface: "page", mode: "persuade", tier: "working", style: "alpha" });
    expect(store.getThread(c.id).designDirection?.style).toBe("style:alpha");
  });

  it("refuses a slide style on a page and a web style on a deck", () => {
    const { service, project } = shortlistSetup();
    const thread = service.createThread(project.id, undefined, "design");
    expect(() => service.setDesignDirection(thread.id, { surface: "page", mode: "read", tier: "working", style: "slides" })).toThrow("made for slides");
    expect(() => service.setDesignDirection(thread.id, { surface: "deck", mode: "read", tier: "working", style: "alpha" })).toThrow(
      'Style "alpha" is not a slide style; this surface is deck. Pick one of: slides.',
    );
  });
});

describe("a kit system on a design thread", () => {
  const FOUNDATION = join(process.cwd(), "resources", "design-kits", "foundation");

  function kitSetup() {
    const parts = setup();
    parts.service.setDesignKitLookup((id) => (id === "foundation" ? FOUNDATION : null));
    const thread = parts.service.createThread(parts.project.id, undefined, "design");
    return { ...parts, thread };
  }

  it("keeps a kit id, and falls back to Auto for one nothing can find", () => {
    const { service, thread } = kitSetup();
    expect(service.setDesignSystem(thread.id, "kit:foundation").designSystem).toBe("kit:foundation");
    expect(service.setDesignSystem(thread.id, "kit:foundation/riso").designSystem).toBe("kit:foundation/riso");
    expect(service.setDesignSystem(thread.id, "kit:foundation/no-such-theme").designSystem).toBe("auto");
    expect(service.setDesignSystem(thread.id, "kit:other").designSystem).toBe("auto");
  });

  it("stays out of today's picker and Auto's style library", () => {
    const { service, project } = kitSetup();
    expect(service.designSystems(project.id).some((s) => s.id.startsWith("kit:"))).toBe(false);
    expect(service.designStyles().every((s) => s.kit === undefined)).toBe(true);
    expect(service.previewSystem(project.id, "kit:foundation")?.source).toBe("kit");
  });

  it("puts an Auto pick on Foundation in that style, with the kit's parts in system/ and a reply that says to build from them", () => {
    const { service, store, thread } = kitSetup();
    const reply = service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "riso" });
    expect(store.getThread(thread.id).designDirection?.style).toBe("kit:foundation/riso");
    const root = service.designRoot(thread.id)!;
    expect(readFileSync(join(root, "system", "DESIGN.md"), "utf8")).toBe("# riso\n");
    for (const f of ["KIT.md", "ui.css", "components.json", "tokens.css"]) expect(existsSync(join(root, "system", f))).toBe(true);
    expect(reply).toContain("the Foundation kit in the riso name theme");
    expect(reply).toContain("`system/KIT.md`");
    expect(reply).toContain("`system/ui.css`");
    expect(reply).toContain("data-ui");
    // A Foundation id given outright goes through the same style checks.
    expect(() => service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "kit:foundation/nope" })).toThrow('Unknown style "kit:foundation/nope"');
  });

  it("takes another installed kit's theme, and refuses a kit or theme that isn't there", () => {
    const { service, store, project } = setup();
    const mui = join(process.cwd(), "design-kits", "kits", "mui");
    service.setDesignKitLookup((id) => (id === "foundation" ? FOUNDATION : id === "mui" ? mui : null));
    const thread = service.createThread(project.id, undefined, "design");
    const reply = service.setDesignDirection(thread.id, { surface: "screen", mode: "operate", tier: "working", style: "kit:mui/indigo" });
    expect(store.getThread(thread.id).designDirection?.style).toBe("kit:mui/indigo");
    expect(reply).toContain("the mui kit in the");
    expect(existsSync(join(service.designRoot(thread.id)!, "system", "ui.css"))).toBe(true);
    expect(() => service.setDesignDirection(thread.id, { surface: "screen", mode: "operate", tier: "working", style: "kit:mui/plaid" })).toThrow(/mui has no theme "plaid"\. Pick one of: .*indigo/);
    expect(() => service.setDesignDirection(thread.id, { surface: "screen", mode: "operate", tier: "working", style: "kit:chakra-ui/blue" })).toThrow('The kit "chakra-ui" isn\'t installed');
  });

  it("never writes into a bundled kit", () => {
    const { service, thread } = kitSetup();
    service.setDesignSystem(thread.id, "kit:foundation");
    const before = readFileSync(join(FOUNDATION, "DESIGN.md"), "utf8");
    const { thread: moved } = service.editDesignSystem(thread.id, { designMd: "over" });
    expect(readFileSync(join(FOUNDATION, "DESIGN.md"), "utf8")).toBe(before);
    expect(moved.designSystem).toBe("project:foundation-custom");
  });
});
