import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { FACES } from "../src/main/design/reference-adapter";
import { materializeSystem, pickFromShortlist, tokenFacets, type DesignSystemInfo } from "../src/main/design/systems";
import { Service } from "../src/main/service";
import { readDirection, SURFACES } from "../src/shared/direction";
import type { DesignKitOption } from "../src/shared/design-mutation";
import { tierOf } from "../src/shared/tiers";
import { catalog, closeAfter, tempDir } from "./helpers";

const RESOURCES = join(__dirname, "..", "resources");
const FOUNDATION = join(RESOURCES, "design-kits", "foundation");
const KITS = join(__dirname, "..", "design-kits", "kits");

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

/** A service with Foundation and the given installed kits from design-kits/, and no style library (it's retired). */
function setup(kits: string[] = ["mui"]) {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const driver = fakeDriver();
  const service = new Service(store, () => catalog(), [driver], () => {});
  service.setDesignKitLookup((id) => (id === "foundation" ? FOUNDATION : kits.includes(id) ? join(KITS, id) : null));
  service.setDesignFontsDir(join(RESOURCES, "design-fonts"));
  service.setDesignPatternsDir(join(RESOURCES, "design-patterns"));
  service.setDesignIconsDir(join(RESOURCES, "design-icons"));
  const options: DesignKitOption[] = [{ id: "foundation", name: "Foundation", version: "1.0.0", bundled: true, installed: true }, ...kits.map((id) => ({ id, name: id, version: "1.0.0", bundled: false, installed: true }))];
  service.kits.connect({ documents: { text: () => "", apply: () => ({ ok: true }) }, pageFile: () => null, catalog: () => options });
  const project = store.addProject(tempDir());
  return { store, service, driver, project };
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

describe("materializeSystem fonts", () => {
  it("copies a system's fonts into system/fonts and removes them on a switch to a system without fonts", () => {
    const root = tempDir();
    const font = join(root, "riso-display.woff2");
    writeFileSync(font, "FONT");
    const sys = (id: string, fontFiles?: string[]): DesignSystemInfo => {
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "DESIGN.md"), `# ${id}\n`);
      writeFileSync(join(dir, "tokens.css"), ":root { --color-bg: #fff; }\n");
      return { id: `project:${id}`, name: id, description: "", swatches: [], source: "projectFolder", designMd: join(dir, "DESIGN.md"), tokensCss: join(dir, "tokens.css"), ...(fontFiles ? { fontFiles } : {}) };
    };
    const dest = join(tempDir(), "system");
    materializeSystem(sys("riso", [font]), dest);
    expect(readFileSync(join(dest, "fonts", "riso-display.woff2"), "utf8")).toBe("FONT");
    materializeSystem(sys("swiss"), dest);
    expect(existsSync(join(dest, "fonts", "riso-display.woff2"))).toBe(false);
    expect(readFileSync(join(dest, ".system"), "utf8")).toBe("project:swiss");
  });
});

describe("Auto design threads", () => {
  it("start on Auto when no system (or a gone one, such as a retired style) is picked; an explicit pick and chat threads are unchanged", () => {
    const { service, project } = setup();
    expect(service.createThread(project.id, undefined, "design").designSystem).toBe("auto");
    expect(service.createThread(project.id, undefined, "design", "kit:mui/indigo").designSystem).toBe("kit:mui/indigo");
    expect(service.createThread(project.id, undefined, "design", "style:swiss-grid").designSystem).toBe("auto");
    expect(service.createThread(project.id, undefined, "design", "clean").designSystem).toBe("auto");
    expect(service.createThread(project.id).designSystem).toBeUndefined();
  });

  it("tell the agent to set a direction until it does, then put the chosen kit theme in system/", async () => {
    const { service, driver, project } = setup();
    const thread = service.createThread(project.id, undefined, "design");
    await service.send({ threadId: thread.id, text: "a landing page" });
    expect(driver.prompts[0]).toContain("call design_set_direction once");
    expect(driver.prompts[0]).not.toContain("Prototype tier");
    const root = service.designRoot(thread.id)!;
    expect(existsSync(join(root, "system", "DESIGN.md"))).toBe(false);

    const reply = service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "kit:mui/teal" });
    expect(reply).toContain("Direction: page, Persuade, tier working.");
    expect(reply).toContain("the mui kit in the");
    expect(reply).toContain("Prototype tier: Working.");
    expect(readFileSync(join(root, "system", "tokens.css"), "utf8")).toBe(readFileSync(join(KITS, "mui", "themes", "teal", "tokens.css"), "utf8"));
    expect(readFileSync(join(root, ".tier"), "utf8")).toBe("working");

    await service.send({ threadId: thread.id, text: "make it bolder" });
    expect(driver.prompts[1]).not.toContain("design_set_direction");
    expect(driver.prompts[1]).not.toContain("Prototype tier");
  });

  it("put an unknown theme name on Foundation's base theme, and store a valid direction", () => {
    const { service, store, project } = setup();
    const thread = service.createThread(project.id, undefined, "design");
    const reply = service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "nope" });
    expect(reply).toContain('Foundation has no theme "nope", so this is its base theme.');
    expect(reply).not.toContain("Pick one of");
    service.setDesignDirection(thread.id, { surface: "screen", mode: "operate", tier: "real-app", style: "kit:foundation" });
    const saved = store.getThread(thread.id);
    expect(saved.designDirection).toEqual({ surface: "screen", mode: "operate", tier: "real-app", style: "kit:foundation" });
    expect(tierOf(saved)).toBe("real-app");
  });

  it("follow the project's own DESIGN.md whatever style the agent names", () => {
    const { service, project } = setup();
    writeFileSync(join(project.path, "DESIGN.md"), "# Ours\n");
    const thread = service.createThread(project.id, undefined, "design");
    const reply = service.setDesignDirection(thread.id, { surface: "page", mode: "read", tier: "working", style: "kit:mui/teal" });
    expect(reply).toContain("Project");
    expect(readFileSync(join(service.designRoot(thread.id)!, "system", "DESIGN.md"), "utf8")).toBe("# Ours\n");
  });

  it("tell a new Auto thread which themes the project used recently", () => {
    const { service, driver, project } = setup();
    const first = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(first.id, { surface: "page", mode: "persuade", tier: "working", style: "kit:mui/teal" });
    const second = service.createThread(project.id, undefined, "design");
    return service.send({ threadId: second.id, text: "another page" }).then(() => {
      expect(driver.prompts[0]).toContain("Recently used in this project: teal;");
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

describe("More styles without design references", () => {
  const variants = (text: string): string[] => [...text.matchAll(/`variant-([a-z0-9-]+)\.html`/g)].map((m) => m[1]!);

  it("needs a built design, then copies 3 installed kit themes spread over kits and asks for one variant each", () => {
    const { service, project } = setup(["mui", "shadcn-ui"]);
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "kit:mui/teal" });
    expect(() => service.prepareMoreStyles(thread.id)).toThrow("Build the design first.");
    const root = service.designRoot(thread.id)!;
    writeFileSync(join(root, "index.html"), "<h1>x</h1>");
    const { names, text } = service.prepareMoreStyles(thread.id);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
    const ids = variants(text);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain("mui-teal");
    // Away from the current kit first: not all three are MUI themes.
    expect(ids.filter((id) => id.startsWith("mui")).length).toBeLessThan(3);
    for (const id of ids) {
      for (const f of ["DESIGN.md", "tokens.css", "ui.css", ".system"]) expect(existsSync(join(root, "styles", id, f)), `${id} ${f}`).toBe(true);
      expect(text).toContain(`link \`styles/${id}/tokens.css\` then \`styles/${id}/ui.css\``);
    }
    expect(text).toContain("Leave index.html and system/ as they are.");
    expect(text).toContain("Build only the pages listed here");
  });

  it("says what to do when there is nothing else to offer", () => {
    const { service, project } = setup([]);
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "kit:foundation" });
    writeFileSync(join(service.designRoot(thread.id)!, "index.html"), "<h1>x</h1>");
    expect(() => service.prepareMoreStyles(thread.id)).toThrow(/Download the design references .* or install another kit/);
  });

  it("a new round drops the folders an earlier, unbuilt round left, and keeps used ones", () => {
    const { service, project } = setup(["mui", "shadcn-ui"]);
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "kit:mui/teal" });
    const root = service.designRoot(thread.id)!;
    writeFileSync(join(root, "index.html"), "<h1>x</h1>");
    const [built, linked, failed] = variants(service.prepareMoreStyles(thread.id).text) as [string, string, string];
    writeFileSync(join(root, `variant-${built}.html`), "<h1>built</h1>");
    writeFileSync(join(root, "index.html"), `<link rel="stylesheet" href="styles/${linked}/tokens.css">`);
    const { text } = service.prepareMoreStyles(thread.id);
    expect(existsSync(join(root, "styles", built))).toBe(true);
    expect(existsSync(join(root, "styles", linked))).toBe(true);
    if (!text.includes(`variant-${failed}.html`)) expect(existsSync(join(root, "styles", failed))).toBe(false);
  });

  it("promoting a kit theme's variant moves an Auto thread to that theme; an agent's own variant moves nothing", () => {
    const { service, store, project } = setup(["mui", "shadcn-ui"]);
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "kit:mui/teal" });
    const root = service.designRoot(thread.id)!;
    writeFileSync(join(root, "index.html"), "<h1>old</h1>");
    const [first] = variants(service.prepareMoreStyles(thread.id).text) as [string];
    const id = readFileSync(join(root, "styles", first, ".system"), "utf8");
    writeFileSync(join(root, `variant-${first}.html`), "<h1>new</h1>");
    service.promoteDesignVariant(thread.id, `variant-${first}.html`);
    expect(store.getThread(thread.id).designDirection?.style).toBe(id);
    expect(store.getThread(thread.id).designSystem).toBe("auto");

    writeFileSync(join(root, "variant-b.html"), "<h1>b</h1>");
    service.promoteDesignVariant(thread.id, "variant-b.html");
    expect(store.getThread(thread.id).designDirection?.style).toBe(id);
  });
});

describe("design direction notes", () => {
  it("copies the surface's pattern notes into system/ and asks for a brief", () => {
    const { service, project } = setup();
    const thread = service.createThread(project.id, undefined, "design");
    const reply = service.setDesignDirection(thread.id, { surface: "workspace", mode: "operate", tier: "working", style: "kit:foundation" });
    const root = service.designRoot(thread.id)!;
    expect(readFileSync(join(root, "system", "patterns.md"), "utf8")).toContain("# Workspace patterns");
    expect(reply).toContain("system/patterns.md");
    expect(reply).toContain("brief.md");
    service.setDesignDirection(thread.id, { surface: "mobile", mode: "operate", tier: "working", style: "kit:foundation" });
    expect(readFileSync(join(root, "system", "patterns.md"), "utf8")).toContain("# Mobile patterns");
  });

  it("copies the AI-parts notes beside the patterns on any surface but slides", () => {
    const { service, project } = setup();
    const thread = service.createThread(project.id, undefined, "design");
    const reply = service.setDesignDirection(thread.id, { surface: "screen", mode: "operate", tier: "working", style: "kit:foundation" });
    const root = service.designRoot(thread.id)!;
    expect(readFileSync(join(root, "system", "ai-parts.md"), "utf8")).toContain("**Tool call card**");
    expect(reply).toContain("system/ai-parts.md");
    const deck = service.createThread(project.id, undefined, "design");
    expect(service.setDesignDirection(deck.id, { surface: "deck", mode: "persuade", tier: "working", style: "kit:foundation" })).not.toContain("ai-parts");
  });

  it("copies the icon sprite into system/ and names it in the reply", () => {
    const { service, project } = setup();
    const thread = service.createThread(project.id, undefined, "design");
    const reply = service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "kit:foundation" });
    const root = service.designRoot(thread.id)!;
    expect(readFileSync(join(root, "system", "icons.svg"), "utf8")).toContain('<symbol id="search"');
    expect(reply).toContain("system/icons.svg");
  });

  it("ships a sprite of stroked line icons without the stock AI-magic ones", () => {
    const sprite = readFileSync(join(RESOURCES, "design-icons", "icons.svg"), "utf8");
    const ids = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(100);
    expect(ids).not.toContain("sparkles");
    expect(ids).not.toContain("rocket");
    for (const symbol of sprite.match(/<symbol id=[^>]*>/g) ?? []) expect(symbol).toContain('stroke="currentColor"');
  });

  it("ships pattern notes for every surface", () => {
    for (const s of SURFACES) expect(existsSync(join(RESOURCES, "design-patterns", `${s}.md`))).toBe(true);
  });
});

describe("the bundled font pack", () => {
  it("has every face the reference adapter names, each with a license", () => {
    const licenses = readFileSync(join(RESOURCES, "design-fonts", "LICENSES.md"), "utf8");
    const files = new Set(readdirSync(join(RESOURCES, "design-fonts")));
    for (const face of FACES) {
      expect(files.has(face.file), face.file).toBe(true);
      expect(licenses, face.family).toContain(`## ${face.family}`);
    }
  });

  it("no longer ships the retired style library", () => {
    expect(existsSync(join(RESOURCES, "design-styles"))).toBe(false);
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

describe("theme shortlist", () => {
  const DIRECTION = { surface: "page", mode: "persuade", tier: "working" } as const;

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

  it("stores the given theme unchanged when there are no alternates", () => {
    const { service, store, project } = setup();
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { ...DIRECTION, style: "kit:mui/indigo" });
    expect(store.getThread(thread.id).designDirection?.style).toBe("kit:mui/indigo");
  });

  it("picks the same shortlist theme each time on the same thread", () => {
    const { service, store, project } = setup();
    const thread = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(thread.id, { ...DIRECTION, style: "kit:mui/indigo" }, ["green", "pink"]);
    const once = store.getThread(thread.id).designDirection?.style;
    service.setDesignDirection(thread.id, { ...DIRECTION, style: "kit:mui/indigo" }, ["green", "pink"]);
    expect(store.getThread(thread.id).designDirection?.style).toBe(once);
    expect(["kit:mui/indigo", "kit:mui/green", "kit:mui/pink"]).toContain(once);
  });

  it("varies the pick across parallel threads without leaving the shortlist", () => {
    const stored: string[] = [];
    for (let i = 0; i < 30; i++) {
      // A project each, so no thread's pick counts as another's recent one.
      const { service, store, project } = setup();
      const thread = service.createThread(project.id, undefined, "design");
      service.setDesignDirection(thread.id, { ...DIRECTION, style: "kit:mui/indigo" }, ["green", "pink"]);
      stored.push(store.getThread(thread.id).designDirection?.style ?? "");
    }
    expect(new Set(stored).size).toBeGreaterThanOrEqual(2);
    for (const style of stored) expect(["kit:mui/indigo", "kit:mui/green", "kit:mui/pink"]).toContain(style);
  });

  it("says so when CubiQ picked off the shortlist, and says the theme was the agent's without alternates", () => {
    let shortlistReply = "";
    for (let i = 0; i < 40 && !shortlistReply; i++) {
      const { service, store, project } = setup();
      const thread = service.createThread(project.id, undefined, "design");
      const reply = service.setDesignDirection(thread.id, { ...DIRECTION, style: "kit:mui/indigo" }, ["green", "pink"]);
      if (store.getThread(thread.id).designDirection?.style !== "kit:mui/indigo") shortlistReply = reply;
    }
    expect(shortlistReply).toContain("CubiQ picked it from your shortlist");
    const { service, project } = setup();
    const plain = service.createThread(project.id, undefined, "design");
    expect(service.setDesignDirection(plain.id, { ...DIRECTION, style: "kit:mui/indigo" })).toContain("(the style you picked)");
  });

  it("ignores alternates that aren't this kit's themes", () => {
    const { service, store, project } = setup();
    const thread = service.createThread(project.id, undefined, "design");
    expect(() => service.setDesignDirection(thread.id, { ...DIRECTION, style: "kit:mui/indigo" }, ["nope", "plaid"])).not.toThrow();
    expect(store.getThread(thread.id).designDirection?.style).toBe("kit:mui/indigo");
  });

  it("drops themes other threads used, and still picks when every candidate is recent", () => {
    const { service, store, project } = setup();
    const a = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(a.id, { ...DIRECTION, style: "kit:mui/indigo" });
    const b = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(b.id, { ...DIRECTION, style: "kit:mui/indigo" }, ["green"]);
    expect(store.getThread(b.id).designDirection?.style).toBe("kit:mui/green");
    const c = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(c.id, { ...DIRECTION, style: "kit:mui/indigo" });
    expect(store.getThread(c.id).designDirection?.style).toBe("kit:mui/indigo");
  });
});

describe("a kit system on a design thread", () => {
  function kitSetup() {
    const parts = setup();
    const thread = parts.service.createThread(parts.project.id, undefined, "design");
    return { ...parts, thread };
  }

  it("keeps a kit id, and falls back to Auto for one nothing can find (a retired style included)", () => {
    const { service, thread } = kitSetup();
    expect(service.setDesignSystem(thread.id, "kit:foundation").designSystem).toBe("kit:foundation");
    expect(service.setDesignSystem(thread.id, "kit:mui/indigo").designSystem).toBe("kit:mui/indigo");
    expect(service.setDesignSystem(thread.id, "kit:foundation/riso-print").designSystem).toBe("auto");
    expect(service.setDesignSystem(thread.id, "kit:foundation/no-such-theme").designSystem).toBe("auto");
    expect(service.setDesignSystem(thread.id, "kit:other").designSystem).toBe("auto");
  });

  it("stays out of today's flat picker list", () => {
    const { service, project } = kitSetup();
    expect(service.designSystems(project.id).some((s) => s.id.startsWith("kit:"))).toBe(false);
    expect(service.previewSystem(project.id, "kit:foundation")?.source).toBe("kit");
  });

  it("puts an Auto pick with no reference on Foundation's base theme, with the kit's parts in system/ and a reply that says to build from them", () => {
    const { service, store, thread } = kitSetup();
    const reply = service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "kit:foundation" });
    expect(store.getThread(thread.id).designDirection?.style).toBe("kit:foundation");
    const root = service.designRoot(thread.id)!;
    expect(readFileSync(join(root, "system", "DESIGN.md"), "utf8")).toBe(readFileSync(join(FOUNDATION, "DESIGN.md"), "utf8"));
    for (const f of ["ui.css", "components.json", "tokens.css"]) expect(existsSync(join(root, "system", f))).toBe(true);
    expect(reply).toContain("the Foundation kit in the Foundation theme");
    expect(reply).toContain("`system/ui.css`");
    expect(reply).toContain("data-ui");
    // A retired Foundation theme given outright lands on the base theme too.
    expect(() => service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "kit:foundation/nope" })).not.toThrow();
    expect(store.getThread(thread.id).designDirection?.style).toBe("kit:foundation");
  });

  it("takes another installed kit's theme, and refuses a kit or theme that isn't there", () => {
    const { service, store, project } = setup();
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
