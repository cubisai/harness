import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { listDesignStyles, materializeSystem, styleIndex } from "../src/main/design/systems";
import { Service } from "../src/main/service";
import { readDirection } from "../src/shared/direction";
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

/** A style library with two styles (one with a font) and a font pack, plus a built-in "clean" system. */
function library(): { styles: string; fonts: string; systems: string } {
  const root = tempDir();
  const styles = join(root, "styles");
  const fonts = join(root, "fonts");
  const systems = join(root, "systems");
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
  mkdirSync(join(systems, "clean"), { recursive: true });
  writeFileSync(join(systems, "clean", "index.md"), "---\ntype: design-system\nname: Clean\n---\n");
  writeFileSync(join(systems, "clean", "DESIGN.md"), "# Clean\n");
  writeFileSync(join(systems, "clean", "tokens.css"), ":root{}\n");
  return { styles, fonts, systems };
}

function setup() {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const driver = fakeDriver();
  const service = new Service(store, () => catalog(), [driver], () => {});
  const lib = library();
  service.setDesignSystemsDir(lib.systems);
  service.setDesignStylesDir(lib.styles, lib.fonts);
  const project = store.addProject(tempDir());
  return { store, service, driver, project, lib };
}

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
  it("start on Auto when no system is picked; an explicit pick and chat threads are unchanged", () => {
    const { service, project } = setup();
    expect(service.createThread(project.id, undefined, "design").designSystem).toBe("auto");
    expect(service.createThread(project.id, undefined, "design", "clean").designSystem).toBe("clean");
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

  it("leave a legacy thread (no system stored) on the old default", async () => {
    const { service, store, driver, project } = setup();
    const legacy = service.createThread(project.id, undefined, "design");
    store.setDesignSystem(legacy.id, null);
    await service.send({ threadId: legacy.id, text: "x" });
    expect(driver.prompts[0]).not.toContain("design_set_direction");
    expect(driver.prompts[0]).toContain("Prototype tier: Working.");
    expect(readFileSync(join(service.designRoot(legacy.id)!, "system", "DESIGN.md"), "utf8")).toBe("# Clean\n");
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

  it("keeps the index the direction tool carries under ~800 tokens", () => {
    expect(Math.ceil(Buffer.byteLength(styleIndex(styles)) / 3)).toBeLessThanOrEqual(800);
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
