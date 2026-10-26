import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import { createGuide } from "../src/main/guide";
import { estimateTokens } from "../src/main/handoff";
import { discoverSkills } from "../src/main/skills/discover";
import { mergeCatalog } from "../src/main/skills/catalog";
import { forAgent } from "../src/main/skills/sources";
import { listDesignSystems } from "../src/main/design/systems";
import { EXPERTS } from "../src/shared/experts";
import { catalog, closeAfter, tempDir } from "./helpers";

const RESOURCES = join(__dirname, "..", "resources");
const DESIGN_SKILLS = ["design-critique", "design-handoff", "design-mobile", "design-prototype", "design-slides", "design-system-extract"];
const BUILT_INS = ["clean", "dashboard", "editorial", "mono", "playful"];
const STITCH_SECTIONS = [
  "## 1. Visual theme and atmosphere",
  "## 2. Color palette and roles",
  "## 3. Typography rules",
  "## 4. Component stylings",
  "## 5. Layout principles",
  "## 6. Depth and elevation",
  "## 7. Do's and don'ts",
  "## 8. Responsive behavior",
  "## 9. Agent prompt guide",
];

describe("Design mode guide (DESIGN-MODE.md)", () => {
  const designMode = join(RESOURCES, "DESIGN-MODE.md");

  it("stays within its 1300-token budget (the brief step, 2026-10-26)", () => {
    const text = readFileSync(designMode, "utf8").replace(/\r\n?/g, "\n").trim();
    expect(estimateTokens(text)).toBeLessThanOrEqual(1300);
  });

  it("ends a design thread's guide with Design mode's text for its folder, stable across calls", () => {
    const root = tempDir();
    const bundled = join(root, "CUBIQ.md");
    writeFileSync(bundled, "bundled");
    const guide = createGuide({ bundled, global: join(root, "none.md"), designMode });
    const text = guide.forCwd(join(root, "project"), "designs/abcd1234");
    expect(text.startsWith("bundled\n\n# Design thread")).toBe(true);
    expect(text).toContain("`designs/abcd1234/index.html`");
    expect(text).toContain("`designs/abcd1234/system/`");
    expect(text).not.toContain("{dir}");
    for (const skill of DESIGN_SKILLS) expect(text).toContain(`\`${skill}\``);
    expect(guide.forCwd(join(root, "project"), "designs/abcd1234")).toBe(text);
  });

  it("leaves a chat thread's guide unchanged", () => {
    const root = tempDir();
    const bundled = join(root, "CUBIQ.md");
    writeFileSync(bundled, "bundled");
    expect(createGuide({ bundled, global: join(root, "none.md"), designMode }).forCwd(join(root, "project"))).toBe("bundled");
  });
});

describe("bundled design skills", () => {
  const bundled = discoverSkills({ origin: "bundled", dir: join(RESOURCES, "skills") });

  it("ships the six design skills, all design-only and model-invoked", () => {
    const design = bundled.filter((s) => s.name.startsWith("design-"));
    expect(design.map((s) => s.name).sort()).toEqual(DESIGN_SKILLS);
    for (const s of design) {
      expect(s.mode).toBe("design");
      expect(s.invocation).toBe("model");
    }
  });

  it("keeps them out of a chat thread's delivery and in a design thread's", () => {
    const cat = mergeCatalog([bundled], new Set());
    const chat = forAgent(cat, { mode: "plugin" }).map((s) => s.name);
    const design = forAgent(cat, { mode: "plugin" }, new Set(), { design: true }).map((s) => s.name);
    expect(chat.some((n) => n.startsWith("design-"))).toBe(false);
    // The chat set is exactly the non-design bundled skills, as before D3.
    expect(chat.sort()).toEqual(bundled.filter((s) => s.mode !== "design").map((s) => s.name).sort());
    expect(design.filter((n) => n.startsWith("design-")).sort()).toEqual(DESIGN_SKILLS);
  });

  it("references only files that exist in their folders", () => {
    const refs: Record<string, string[]> = {
      "design-prototype": ["assets/index.html"],
      "design-mobile": ["assets/index.html"],
      "design-slides": ["assets/index.html", "assets/deck.css", "assets/deck.js"],
      "design-critique": ["references/rubric.md"],
      "design-handoff": ["assets/handoff-template.md"],
    };
    for (const [skill, files] of Object.entries(refs)) {
      const body = readFileSync(join(RESOURCES, "skills", skill, "SKILL.md"), "utf8");
      for (const f of files) {
        expect(body).toContain(f);
        expect(existsSync(join(RESOURCES, "skills", skill, f))).toBe(true);
      }
    }
  });
});

describe("built-in design systems", () => {
  const systems = listDesignSystems(null, join(RESOURCES, "design-systems"));

  it("lists the five built-ins with names, descriptions and four swatches", () => {
    expect(systems.map((s) => s.id)).toEqual(BUILT_INS);
    for (const s of systems) {
      expect(s.source).toBe("builtin");
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.swatches).toHaveLength(4);
      expect(s.tokensCss).toBeDefined();
    }
  });

  it("has a DESIGN.md with the nine Stitch sections in order", () => {
    for (const s of systems) {
      const text = readFileSync(s.designMd, "utf8");
      let at = -1;
      for (const heading of STITCH_SECTIONS) {
        const i = text.indexOf(heading);
        expect(i, `${s.id}: ${heading}`).toBeGreaterThan(at);
        at = i;
      }
    }
  });

  it("puts every spacing token on the 8pt scale and shares one token contract", () => {
    const scale = new Set([4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96]);
    const names = (css: string) => [...css.matchAll(/(--[\w-]+):/g)].map((m) => m[1]).sort();
    const first = names(readFileSync(systems[0]!.tokensCss!, "utf8"));
    for (const s of systems) {
      const css = readFileSync(s.tokensCss!, "utf8");
      const spaces = [...css.matchAll(/--space-\d+:\s*(\d+)px/g)].map((m) => Number(m[1]));
      expect(spaces.length).toBe(11);
      for (const px of spaces) expect(scale.has(px), `${s.id}: ${px}px`).toBe(true);
      for (const lh of [...css.matchAll(/--leading-[\w]+:\s*(\d+)px/g)].map((m) => Number(m[1]))) expect(lh % 4, `${s.id}: leading ${lh}`).toBe(0);
      // Dashboard adds chart colors; everything else is the same set of names.
      expect(names(css).filter((n) => !n!.startsWith("--color-chart-"))).toEqual(first);
      expect(css).not.toMatch(/url\(|@import|https?:/);
    }
  });
});

describe("Service design systems", () => {
  function setup(designSystemsDir: string) {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const prompts: string[] = [];
    const inputs: TurnInput[] = [];
    const driver: AgentDriver = {
      id: "fake",
      label: "Fake",
      defaultModel: "m1",
      capabilities: SAFE_DEFAULTS,
      skillsDelivery: { mode: "none" },
      skillCallPrefix: "skilled:",
      models: () => [{ id: "m1", label: "Model 1" }],
      async runTurn(input: TurnInput) {
        prompts.push(input.prompt);
        inputs.push(input);
        input.onSession("s1");
        input.onEvent({ kind: "assistant-text", text: "ok" });
      },
    };
    const service = new Service(store, () => catalog(), [driver], () => {});
    service.setDesignSystemsDir(designSystemsDir);
    const projectDir = tempDir();
    const project = store.addProject(projectDir);
    return { store, service, project, projectDir, prompts, inputs };
  }

  it("copies the thread's system into its design folder before the turn, and says a switch once", async () => {
    const { service, project, projectDir, prompts } = setup(join(RESOURCES, "design-systems"));
    const thread = service.createThread(project.id, undefined, "design", "editorial");
    expect(thread.designSystem).toBe("editorial");
    await service.send({ threadId: thread.id, text: "a landing page" });
    const dir = join(projectDir, "designs", thread.id.slice(0, 8), "system");
    expect(readFileSync(join(dir, ".system"), "utf8")).toBe("editorial");
    expect(readFileSync(join(dir, "tokens.css"), "utf8")).toBe(readFileSync(join(RESOURCES, "design-systems", "editorial", "tokens.css"), "utf8"));
    // The first turn also says the prototype tier (once); the system is never named until it changes.
    expect(prompts[0]!.startsWith("a landing page\n\n(CubiQ: Prototype tier: Working.")).toBe(true);
    expect(prompts[0]).not.toContain("design system is now");

    service.setDesignSystem(thread.id, "mono");
    await service.send({ threadId: thread.id, text: "again" });
    expect(readFileSync(join(dir, ".system"), "utf8")).toBe("mono");
    expect(prompts[1]).toContain("the design system is now Mono");
    await service.send({ threadId: thread.id, text: "third" });
    expect(prompts[2]).toBe("third");
  });

  it("defaults to the project's DESIGN.md, then Clean, for a thread with no stored system; Auto follows the project's own", async () => {
    const { service, store, project, projectDir, prompts } = setup(join(RESOURCES, "design-systems"));
    const a = service.createThread(project.id, undefined, "design");
    expect(a.designSystem).toBe("auto");
    store.setDesignSystem(a.id, null);
    await service.send({ threadId: a.id, text: "x" });
    expect(readFileSync(join(projectDir, "designs", a.id.slice(0, 8), "system", ".system"), "utf8")).toBe("clean");

    writeFileSync(join(projectDir, "DESIGN.md"), "# Ours");
    const b = service.createThread(project.id, undefined, "design");
    await service.send({ threadId: b.id, text: "x" });
    expect(prompts[1]).toContain('follows the project\'s own DESIGN.md. Before you build, call design_set_direction once with the surface, mode and tier; use style "project".');
    const dir = join(projectDir, "designs", b.id.slice(0, 8), "system");
    expect(readFileSync(join(dir, "DESIGN.md"), "utf8")).toBe("# Ours");
    expect(existsSync(join(dir, "tokens.css"))).toBe(false);
    expect(service.designSystems(project.id).map((s) => s.id)).toEqual(["project", ...BUILT_INS]);
  });

  it("does nothing for a chat thread, and refuses a system on one", async () => {
    const { service, project, projectDir, prompts } = setup(join(RESOURCES, "design-systems"));
    const chat = service.createThread(project.id, undefined, "chat", "mono");
    expect(chat.designSystem).toBeUndefined();
    await service.send({ threadId: chat.id, text: "hi" });
    expect(prompts[0]).toBe("hi");
    expect(existsSync(join(projectDir, "designs"))).toBe(false);
    expect(() => service.setDesignSystem(chat.id, "mono")).toThrow();
  });

  it("lists a project's own .agents/design-systems between its DESIGN.md and the built-ins", () => {
    const { service, project, projectDir } = setup(join(RESOURCES, "design-systems"));
    const own = join(projectDir, ".agents", "design-systems", "brand");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "index.md"), "---\ntype: design-system\nname: Brand\ndescription: Ours\nswatches: #fff, #000\n---\n");
    writeFileSync(join(own, "DESIGN.md"), "# Brand");
    expect(service.designSystems(project.id).map((s) => s.id)).toEqual(["project:brand", ...BUILT_INS]);
    expect(readdirSync(projectDir)).not.toContain("designs");
  });
});

describe("design experts", () => {
  it("are the five design presets, each with a bundled design skill and a real (or default) system", () => {
    const design = EXPERTS.filter((e) => e.kind === "design");
    expect(design.map((e) => e.name)).toEqual(["UI Designer", "Mobile Designer", "Slide Designer", "Design-System Architect", "UX Critic"]);
    for (const e of design) {
      expect(e.skills?.length).toBeGreaterThan(0);
      for (const skill of e.skills!) expect(DESIGN_SKILLS).toContain(skill);
      if (e.designSystem) expect(BUILT_INS).toContain(e.designSystem);
    }
  });
});
