import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DesignKitOption } from "../src/shared/design-mutation";
import type { LiveUpdate, Thread } from "../src/shared/types";
import { DesignDocuments } from "../src/main/design/documents";
import { DesignKitService } from "../src/main/design/kit-service";
import { documentIdOf } from "../src/main/design/mutation";
import { listDesignSystems, listKitSystems, type DesignSystemInfo } from "../src/main/design/systems";
import { designTools, DESIGN_KIT_INSPECT_TOOL, DESIGN_LINT_TOOL, DESIGN_KIT_SAVE_TOOL, DESIGN_TOKENS_APPLY_TOOL } from "../src/main/design/tools";
import { tempDir } from "./helpers";

const FOUNDATION = join(process.cwd(), "resources", "design-kits", "foundation");
const MUI = join(process.cwd(), "design-kits", "kits", "mui");
const SHADCN = join(process.cwd(), "design-kits", "kits", "shadcn-ui");

const open: DesignDocuments[] = [];
afterEach(() => {
  for (const d of open.splice(0)) d.dispose();
});

/** A real kit service and page editor over one thread, with only the thread store faked. */
function setup(designSystem = "kit:foundation", project: string | null = tempDir()) {
  const root = join(tempDir(), "designs", "abcd1234");
  mkdirSync(root, { recursive: true });
  const thread = { id: "abcd1234-thread", projectId: "p", kind: "design", designSystem } as unknown as Thread;
  const threads = [thread];
  const updates: LiveUpdate[] = [];
  const kitDir = (id: string) => ({ foundation: FOUNDATION, mui: MUI, "shadcn-ui": SHADCN })[id] ?? null;
  const byId = (id: string | undefined): DesignSystemInfo | null => {
    if (!id) return null;
    // A downloaded reference, as the service resolves one: Foundation's parts under the reference's name.
    if (id.startsWith("ref:")) return { ...listKitSystems(FOUNDATION).find((s) => s.id === "kit:foundation")!, id, name: "Foundation · Acme" };
    if (id.startsWith("kit:")) {
      const dir = kitDir(id.slice(4).split("/")[0]!);
      return dir ? (listKitSystems(dir).find((s) => s.id === id) ?? null) : null;
    }
    return project ? (listDesignSystems(project).find((s) => s.id === id) ?? null) : null;
  };
  const kits = new DesignKitService({
    getThread: (id) => {
      const t = threads.find((x) => x.id === id);
      if (!t) throw new Error("no thread");
      return t;
    },
    threadsOf: () => threads,
    setDesignSystem: (id, system) => {
      const t = threads.find((x) => x.id === id)!;
      t.designSystem = system;
      return t;
    },
    projectPath: () => project,
    designRoot: () => root,
    threadSystem: (t) => byId(t.designSystem),
    systemById: (_p, id) => byId(id),
    kitDir,
    broadcast: (u) => updates.push(u),
  });
  let busy = false;
  const documents = new DesignDocuments({ journalDir: join(tempDir(), "journal"), isBusy: () => busy, debounceMs: 0 });
  open.push(documents);
  const catalog: DesignKitOption[] = [
    { id: "foundation", name: "Foundation", version: "1.0.0", bundled: true, installed: true },
    { id: "mui", name: "MUI", version: "1.0.0", bundled: false, installed: true },
    { id: "chakra-ui", name: "Chakra UI", version: "1.0.0", bundled: false, installed: false },
  ];
  kits.connect({ documents, pageFile: (_t, rel) => join(root, rel), catalog: () => catalog });
  const write = (rel: string, html: string) => writeFileSync(join(root, rel), html);
  return { kits, thread, root, project, updates, documents, write, setBusy: (b: boolean) => (busy = b) };
}

const PAGE = '<!doctype html><html><head><link rel="stylesheet" href="system/tokens.css"><link rel="stylesheet" href="system/ui.css"></head><body><button data-ui="button" data-variant="primary">Go</button><span data-ui="badge">New</span></body></html>';

describe("the picker's lists", () => {
  it("groups themes by kit, and only offers an uninstalled kit by name", () => {
    const { kits } = setup();
    const groups = kits.groups("p");
    expect(groups.map((g) => g.id)).toEqual(["foundation", "mui", "chakra-ui"]);
    const mui = groups[1]!;
    expect(mui.installed).toBe(true);
    expect(mui.components).toBeGreaterThan(50);
    expect(mui.themes.length).toBeGreaterThan(5);
    expect(mui.themes[0]!.card.accent).toBeTruthy();
    expect(mui.themes[0]!.card.dark?.bg).toBeTruthy();
    expect(groups[2]).toMatchObject({ installed: false, themes: [] });
  });

  it("lists a project's own theme first under its kit, and its own new kit as a group", () => {
    const { kits, thread } = setup("kit:mui");
    kits.saveTheme(thread.id, "Brand", { "--color-primary": "#ff0000" });
    const mui = kits.groups("p").find((g) => g.id === "mui")!;
    expect(mui.themes[0]).toMatchObject({ id: "project:brand", mine: true });
    expect(mui.themes[0]!.card.accent).toBe("#ff0000");
  });
});

describe("a theme switch", () => {
  it("swaps tokens now, leaves the page, tells the agent once", () => {
    const { kits, thread, root, write, updates } = setup("kit:mui");
    write("index.html", PAGE);
    const res = kits.applyTheme(thread.id, "kit:mui/teal");
    expect(res.previous).toBe("kit:mui");
    expect(res.thread.designSystem).toBe("kit:mui/teal");
    expect(readFileSync(join(root, "system", ".system"), "utf8")).toBe("kit:mui/teal");
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(PAGE);
    expect(updates.some((u) => u.type === "thread")).toBe(true);
    expect(kits.takeNote(thread)).toMatch(/nothing to rebuild/);
    expect(kits.takeNote(thread)).toBe("");
  });

  it("names a reference target once, without doubling its kit", () => {
    const { kits, thread, write } = setup("kit:mui");
    write("index.html", PAGE);
    expect(kits.migrationPreview(thread.id, "index.html", "ref:acme").targetName).toBe("Foundation · Acme");
    expect(kits.migrationPreview(thread.id, "index.html", "kit:foundation").targetName).toBe("Foundation");
    kits.cancelMigration(thread.id);
  });

  it("refuses a theme of another kit, which has to go through the preview", () => {
    const { kits, thread } = setup("kit:foundation");
    expect(() => kits.applyTheme(thread.id, "kit:mui/teal")).toThrow(/another kit/);
    expect(thread.designSystem).toBe("kit:foundation");
  });
});

describe("a kit move", () => {
  it("previews without touching the page or the thread, and cancel leaves nothing", () => {
    const { kits, thread, root, write } = setup("kit:foundation");
    write("index.html", PAGE);
    const preview = kits.migrationPreview(thread.id, "index.html", "kit:mui");
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(PAGE);
    expect(thread.designSystem).toBe("kit:foundation");
    expect(preview.targetName).toContain("MUI");
    const shown = readFileSync(join(root, preview.previewRel), "utf8");
    expect(shown).toContain('href=".preview/system/ui.css"');
    expect(existsSync(join(root, ".preview", "system", "ui.css"))).toBe(true);
    kits.cancelMigration(thread.id);
    expect(existsSync(join(root, ".preview"))).toBe(false);
    expect(existsSync(join(root, preview.previewRel))).toBe(false);
  });

  it("commits every page as one undo step each, and undo brings the system and the other page back", () => {
    const { kits, thread, root, write, documents } = setup("kit:foundation");
    write("index.html", PAGE);
    write("about.html", PAGE);
    kits.commitMigration(thread.id, "index.html", "kit:mui");
    expect(thread.designSystem).toBe("kit:mui");
    expect(readFileSync(join(root, "system", ".system"), "utf8")).toBe("kit:mui");
    const moved = readFileSync(join(root, "index.html"), "utf8");
    expect(moved).not.toBe(PAGE);
    expect(readFileSync(join(root, "about.html"), "utf8")).toBe(moved);
    expect(existsSync(join(root, ".preview"))).toBe(false);

    const undone = documents.history(thread.id, "index.html", join(root, "index.html"), { action: "undo" });
    expect(undone.html).toBe(PAGE);
    const rest = kits.afterHistory(thread.id, "index.html", undone.html, "undo");
    expect(rest).toEqual(["about.html"]);
    expect(thread.designSystem).toBe("kit:foundation");
    for (const page of rest) documents.history(thread.id, page, join(root, page), { action: "undo" });
    expect(readFileSync(join(root, "about.html"), "utf8")).toBe(PAGE);

    const redone = documents.history(thread.id, "index.html", join(root, "index.html"), { action: "redo" });
    kits.afterHistory(thread.id, "index.html", redone.html, "redo");
    expect(thread.designSystem).toBe("kit:mui");
  });

  it("doesn't take the system back on an ordinary undo after the move", () => {
    const { kits, thread, root, write, documents } = setup("kit:foundation");
    write("index.html", PAGE);
    kits.commitMigration(thread.id, "index.html", "kit:mui");
    const file = join(root, "index.html");
    const status = documents.history(thread.id, "index.html", file, { action: "status" }).status;
    documents.mutate(thread.id, "index.html", file, { operationId: "o1", documentId: documentIdOf(thread.id, "index.html"), baseRevision: status.revision, target: { locator: { tag: "html", path: [] } }, transactionId: "t1", change: { kind: "setProp", name: "lang", value: "en" } });
    const undone = documents.history(thread.id, "index.html", file, { action: "undo" });
    expect(kits.afterHistory(thread.id, "index.html", undone.html, "undo")).toEqual([]);
    expect(thread.designSystem).toBe("kit:mui");
  });
});

describe("tokens from the agent", () => {
  const tools = (s: ReturnType<typeof setup>) =>
    designTools(
      {
        root: () => s.root,
        folder: () => "designs/abcd1234",
        url: () => "",
        screenshot: async () => {
          throw new Error("no");
        },
        evaluate: async () => JSON.stringify({ findings: [], skipped: [], scanned: 3 }),
        lintScript: "",
        saveCritique: () => null,
        setDirection: () => "",
        kitIndex: () => "",
        kits: { inspect: (id, q) => s.kits.inspect(id, q), ground: (id, rel) => s.kits.ground(id, rel), save: (id) => s.kits.saveForAgent(id), applyTokens: (id, rel, t) => s.kits.applyTokens(id, rel, t) },
      },
      s.thread.id,
    );
  const run = async (s: ReturnType<typeof setup>, name: string, args: unknown) => {
    const tool = tools(s).find((t) => t.name === name)!;
    return (tool.run as (a: unknown, ctx?: unknown) => Promise<{ text: string; isError?: boolean }>)(args);
  };
  const ready = () => {
    const s = setup("kit:foundation");
    s.write("index.html", PAGE);
    s.kits.applyTheme(s.thread.id, "kit:foundation");
    s.kits.takeNote(s.thread);
    return s;
  };

  it("are offered only when the kit tools are given", () => {
    const names = (kits: boolean) =>
      designTools({ root: () => null, folder: () => "", url: () => "", screenshot: async () => ({}) as never, evaluate: async () => "", lintScript: "", saveCritique: () => null, setDirection: () => "", kitIndex: () => "", ...(kits ? { kits: { inspect: () => "", ground: () => null, save: () => "", applyTokens: () => "" } } : {}) }, "t").map((t) => t.name);
    expect(names(false)).not.toContain(DESIGN_KIT_SAVE_TOOL);
    expect(names(true)).toEqual(expect.arrayContaining([DESIGN_KIT_INSPECT_TOOL, DESIGN_KIT_SAVE_TOOL, DESIGN_TOKENS_APPLY_TOOL]));
  });

  it("write inline on the page's root, one undo step, even during the turn that asked", async () => {
    const s = ready();
    s.setBusy(true);
    const out = await run(s, DESIGN_TOKENS_APPLY_TOOL, { tokens: { "--color-primary": "#4f46e5", "--radius-md": "10px" } });
    expect(out.isError).toBeFalsy();
    expect(out.text).toMatch(/2 tokens changed.*no components touched/);
    const html = readFileSync(join(s.root, "index.html"), "utf8");
    expect(html).toMatch(/<html[^>]*style="[^"]*--color-primary:\s*#4f46e5/);
    expect(html).toContain('data-ui="button"');
    s.setBusy(false);
    s.documents.setBusy(s.thread.id, false);
    const undone = s.documents.history(s.thread.id, "index.html", join(s.root, "index.html"), { action: "undo" });
    expect(undone.html.replace(/ data-agent-id="[^"]*"/g, "")).toBe(PAGE);
    expect(s.updates.some((u) => u.type === "design-changed")).toBe(true);
  });

  it("stay one undo step past setStyle's 32 at a time", async () => {
    const s = ready();
    const css = readFileSync(join(s.root, "system", "tokens.css"), "utf8");
    const names = [...new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]!))].slice(0, 36);
    expect(names.length).toBeGreaterThan(32);
    const out = await run(s, DESIGN_TOKENS_APPLY_TOOL, { tokens: Object.fromEntries(names.map((n) => [n, "#123456"])) });
    expect(out.isError).toBeFalsy();
    const undone = s.documents.history(s.thread.id, "index.html", join(s.root, "index.html"), { action: "undo" });
    expect(undone.html.replace(/ data-agent-id="[^"]*"/g, "")).toBe(PAGE);
  });

  it("refuse any name the system doesn't have, changing nothing", async () => {
    const s = ready();
    const out = await run(s, DESIGN_TOKENS_APPLY_TOOL, { tokens: { "--color-primary": "#000", "--made-up": "1" } });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("--made-up");
    expect(readFileSync(join(s.root, "index.html"), "utf8")).toBe(PAGE);
    const bad = await run(s, DESIGN_TOKENS_APPLY_TOOL, { tokens: { "--color-primary": "red; }" } });
    expect(bad.isError).toBe(true);
  });

  it("inspect lists a kit, one part and one block, and says so for what isn't there", async () => {
    const s = setup("kit:mui");
    const list = await run(s, DESIGN_KIT_INSPECT_TOOL, {});
    expect(list.text).toMatch(/^MUI 1\.0\.0/);
    expect(list.text).toContain("button");
    const part = await run(s, DESIGN_KIT_INSPECT_TOOL, { component: "button" });
    expect(part.text).toContain('data-ui="button"');
    expect(part.text).toContain("data-variant");
    expect((await run(s, DESIGN_KIT_INSPECT_TOOL, { component: "nope" })).isError).toBe(true);
    expect((await run(s, DESIGN_KIT_INSPECT_TOOL, { kit: "not-here" })).isError).toBe(true);
    expect((await run(s, DESIGN_KIT_INSPECT_TOOL, { kit: "foundation" })).text).toMatch(/^Foundation/);
  });

  it("inspect finds parts by words and lists the parts a page uses", async () => {
    const s = setup("kit:foundation");
    s.write("index.html", PAGE);
    const found = await run(s, DESIGN_KIT_INSPECT_TOOL, { search: "button" });
    expect(found.text).toMatch(/^button: /m);
    expect((await run(s, DESIGN_KIT_INSPECT_TOOL, { search: "zzqx" })).text).toMatch(/^Nothing in Foundation matches/);
    const page = await run(s, DESIGN_KIT_INSPECT_TOOL, { page: "index.html" });
    expect(page.text).toMatch(/^Kit: 2 of 2 elements are Foundation parts/);
    expect(page.text).toMatch(/^button×1: /m);
    expect((await run(s, DESIGN_KIT_INSPECT_TOOL, { page: "../x.html" })).isError).toBe(true);
    expect((await run(s, DESIGN_KIT_INSPECT_TOOL, { page: "gone.html" })).isError).toBe(true);
  });

  it("lint adds the kit check on a kit thread: unknown parts, bad values, redrawn parts, and the coverage line", async () => {
    const s = setup("kit:foundation");
    s.write("index.html", '<html><head><style>[data-ui="button"] { background: red; } .hero { padding: 8px; }</style></head><body><div class="hero"><button data-ui="button" data-variant="huge">Go</button><div data-ui="buton">x</div></div></body></html>');
    const out = await run(s, DESIGN_LINT_TOOL, {});
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("kit 3");
    expect(out.text).toContain('[kit] [data-ui="buton"] — Foundation has no part "buton"');
    expect(out.text).toContain("did you mean button");
    expect(out.text).toMatch(/\[kit\] \[data-ui="button"\]\[data-variant="huge"\] — data-variant="huge" isn't a value of button: use /);
    expect(out.text).toContain("page CSS redraws the kit's button");
    expect(out.text).not.toContain(".hero");
    expect(out.text).toMatch(/Kit: 1 of 3 elements are Foundation parts \(33%\): button×1\./);
  });

  it("lint says nothing about kits off a kit", async () => {
    const s = setup("style:swiss-grid");
    s.write("index.html", PAGE);
    expect(s.kits.ground(s.thread.id, "index.html")).toBeNull();
  });

  it("save refuses a broken draft with its reasons, and switches the thread on a good one", async () => {
    const s = setup("kit:foundation");
    expect((await run(s, DESIGN_KIT_SAVE_TOOL, {})).isError).toBe(true);
    s.kits.setIntent(s.thread.id, { kind: "new-kit", name: "Projects" });
    expect(s.kits.takeNote(s.thread)).toMatch(/design-kit/);
    const path = join(s.root, "kit", "components.json");
    const m = JSON.parse(readFileSync(path, "utf8")) as { kitId: string; name: string; components: Record<string, unknown>[] };
    expect(m.kitId).toBe("my-kit");
    m.kitId = "projects-kit";
    m.name = "Projects kit";
    m.components.push({ name: "Progress Card", ui: "progress-card", snippet: "<div>no attribute</div>", props: [] });
    writeFileSync(path, JSON.stringify(m));
    const broken = await run(s, DESIGN_KIT_SAVE_TOOL, {});
    expect(broken.isError).toBe(true);
    expect(broken.text).toMatch(/progress-card/);
    (m.components[m.components.length - 1] as Record<string, unknown>).snippet = '<div data-ui="progress-card"></div>';
    writeFileSync(path, JSON.stringify(m));
    writeFileSync(join(s.root, "kit", "ui.css"), `${readFileSync(join(s.root, "kit", "ui.css"), "utf8")}\n[data-ui="progress-card"] { padding: 16px; }\n`);
    const good = await run(s, DESIGN_KIT_SAVE_TOOL, {});
    expect(good.isError).toBeFalsy();
    expect(good.text).toContain("New: progress-card");
    expect(s.thread.designSystem).toBe("project:projects-kit");
    expect(readFileSync(join(s.root, "system", ".system"), "utf8")).toBe("project:projects-kit");
    const part = s.kits.doc(s.thread.id).parts.find((p) => p.ui === "progress-card");
    expect(part?.isNew).toBe(true);
    expect(part?.draft).toBe(false);
  });
});

describe("no project folder", () => {
  it("keeps a kit draft in the thread and says why", () => {
    const s = setup("kit:foundation", null);
    s.kits.setIntent(s.thread.id, { kind: "system", where: "System · Colors · Light" });
    s.kits.takeNote(s.thread);
    expect(existsSync(join(s.root, "kit", "components.json"))).toBe(true);
    expect(() => s.kits.saveForAgent(s.thread.id)).toThrow(/project folder/);
    expect(() => s.kits.saveTheme(s.thread.id, "x", {})).toThrow(/project folder/);
    expect(s.kits.doc(s.thread.id).editable).toBe(false);
  });
});

describe("System mode's kit view", () => {
  it("counts where each part is used, across the design's pages", () => {
    const s = setup("kit:foundation");
    s.write("index.html", PAGE);
    s.write("about.html", '<div data-ui="button"></div>');
    const doc = s.kits.doc(s.thread.id);
    expect(doc.copyOnWrite).toBe(true);
    expect(doc.parts.find((p) => p.ui === "button")?.usage).toEqual({ count: 2, files: 2 });
    expect(doc.parts.find((p) => p.ui === "stack")?.usage).toEqual({ count: 0, files: 0 });
    expect(doc.draft).toBeNull();
  });

  it("samples a kit part from the draft's CSS while a system change is under review", () => {
    const s = setup("kit:foundation");
    s.kits.sample(s.thread.id, { ui: "button" });
    expect(readFileSync(join(s.root, ".preview-part.html"), "utf8")).toContain('href="system/ui.css"');
    s.kits.setIntent(s.thread.id, { kind: "system", where: "Library · Button" });
    s.kits.takeNote(s.thread);
    writeFileSync(join(s.root, "kit", "ui.css"), `${readFileSync(join(s.root, "kit", "ui.css"), "utf8")}\n[data-ui="button"] { border-radius: 999px; }\n`);
    s.kits.sample(s.thread.id, { ui: "button" });
    const html = readFileSync(join(s.root, ".preview-part.html"), "utf8");
    expect(html).toContain('href="kit/ui.css"');
    expect(html).not.toContain('href="system/ui.css"');
    s.kits.sample(s.thread.id, { ui: "button", states: true });
    const states = readFileSync(join(s.root, ".preview-part.html"), "utf8");
    expect(states).toContain("border-radius: 999px");
    // Each cell names its state, so a narrow frame can stack them and still say which is which.
    expect(states).toContain('<td data-state="Hover">');
  });

  it("shows a reviewed component as a draft until Save to kit, and Discard removes it", () => {
    const s = setup("kit:foundation");
    s.kits.setIntent(s.thread.id, { kind: "new-component" });
    expect(s.kits.takeNote(s.thread)).toMatch(/Don't call design_kit_save/);
    expect(s.kits.doc(s.thread.id).draft).toBeNull();
    const path = join(s.root, "kit", "components.json");
    const m = JSON.parse(readFileSync(path, "utf8")) as { components: Record<string, unknown>[] };
    m.components.push({ name: "Pricing Card", ui: "pricing-card", snippet: '<div data-ui="pricing-card">$9</div>', props: [] });
    writeFileSync(path, JSON.stringify(m));
    writeFileSync(join(s.root, "kit", "ui.css"), `${readFileSync(join(s.root, "kit", "ui.css"), "utf8")}\n[data-ui="pricing-card"] { padding: 16px; }\n`);
    const doc = s.kits.doc(s.thread.id);
    expect(doc.draft?.added).toEqual(["pricing-card"]);
    expect(doc.parts[0]).toMatchObject({ ui: "pricing-card", draft: true });
    expect(s.kits.sample(s.thread.id, { ui: "pricing-card" })).toBe(".preview-part.html");
    expect(readFileSync(join(s.root, ".preview-part.html"), "utf8")).toContain('href="kit/ui.css"');

    const saved = s.kits.saveForUser(s.thread.id);
    expect(s.thread.designSystem).toBe("project:foundation-custom");
    expect(saved.doc.draft).toBeNull();
    expect(saved.doc.parts.find((p) => p.ui === "pricing-card")).toMatchObject({ draft: false, isNew: false });

    s.kits.setIntent(s.thread.id, { kind: "new-component" });
    s.kits.takeNote(s.thread);
    expect(s.kits.discardDraft(s.thread.id).draft).toBeNull();
    expect(existsSync(join(s.root, "kit"))).toBe(false);
  });

  it("removes a draft that's already saved before the next turn", () => {
    const s = setup("kit:foundation");
    s.kits.setIntent(s.thread.id, { kind: "system", where: "x" });
    s.kits.takeNote(s.thread);
    expect(existsSync(join(s.root, "kit"))).toBe(true);
    s.kits.takeNote(s.thread);
    expect(existsSync(join(s.root, "kit"))).toBe(false);
  });

  it("edits a bundled kit by copying it first, one undo step, and every design on it follows", () => {
    const s = setup("kit:mui");
    const before = readFileSync(join(MUI, "components.json"), "utf8");
    const { thread } = s.kits.edit(s.thread.id, { kind: "addProp", ui: "button", prop: { name: "zz-side", label: "Side", type: "text" } });
    expect(thread.designSystem).toBe("project:mui-custom");
    expect(readFileSync(join(MUI, "components.json"), "utf8")).toBe(before);
    const has = () => s.kits.doc(s.thread.id).parts.find((p) => p.ui === "button")!.props.some((p) => p.name === "zz-side");
    expect(has()).toBe(true);
    expect(readFileSync(join(s.root, "system", "components.json"), "utf8")).toContain("zz-side");
    expect(s.kits.history(s.thread.id, "undo")?.label).toBe("Added prop zz-side");
    expect(has()).toBe(false);
    expect(readFileSync(join(s.root, "system", "components.json"), "utf8")).not.toContain("zz-side");
    s.kits.history(s.thread.id, "redo");
    expect(has()).toBe(true);
    s.kits.history(s.thread.id, "undo");
    expect(s.kits.history(s.thread.id, "undo")).toBeNull();
  });

  it("counts a token's reach through the parts that read it", () => {
    const s = setup("kit:foundation");
    s.write("index.html", PAGE);
    const reach = s.kits.reach(s.thread.id, ["--color-primary"]);
    expect(reach.tokens).toBe(1);
    expect(reach.instances).toBeGreaterThan(0);
    expect(reach.files).toBe(1);
    expect(s.kits.reach(s.thread.id, ["--made-up"]).instances).toBe(0);
  });

  it("saves a composition without a turn, warning first about what won't carry over", () => {
    const s = setup("kit:foundation");
    const warned = s.kits.saveComposition(s.thread.id, "Row", '<div style="color:red">x</div>', false);
    expect(warned.warnings.length).toBe(1);
    expect(warned.saved).toBeNull();
    expect(s.thread.designSystem).toBe("kit:foundation");
    const done = s.kits.saveComposition(s.thread.id, "Row", '<div style="color:red">x</div>', true);
    expect(done.saved).toBe("row");
    expect(s.thread.designSystem).toBe("project:foundation-custom");
    expect(s.kits.doc(s.thread.id).parts.find((p) => p.ui === "row")?.kind).toBe("composition");
    expect(readFileSync(join(s.root, "system", "components.json"), "utf8")).toContain('"row"');
  });

  it("copies Foundation for a new kit only once it's asked for, and moves an Auto thread onto it", () => {
    const s = setup("auto");
    s.kits.setIntent(s.thread.id, { kind: "new-kit" });
    s.kits.setIntent(s.thread.id, null);
    expect(s.kits.takeNote(s.thread)).toBe("");
    expect(existsSync(join(s.root, "kit"))).toBe(false);
    s.kits.setIntent(s.thread.id, { kind: "new-kit" });
    s.kits.takeNote(s.thread);
    expect(s.thread.designSystem).toBe("kit:foundation");
    expect(existsSync(join(s.root, "kit", "ui.css"))).toBe(true);
  });
});

describe("pageCssOf", () => {
  it("reads the page's own linked stylesheets, never system/, styles/ or remote ones", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { pageCssOf } = await import("../src/main/design/kit-service");
    const root = tempDir();
    mkdirSync(join(root, "system"), { recursive: true });
    writeFileSync(join(root, "page.css"), ".a{color:red}");
    writeFileSync(join(root, "system", "ui.css"), ".kit{}");
    const html = `<link rel="stylesheet" href="system/ui.css"><link rel="stylesheet" href="page.css?v=2"><link rel="stylesheet" href="https://x.test/a.css"><link rel="stylesheet" href="../outside.css">`;
    const css = pageCssOf(root, "index.html", html);
    expect(css).toContain(".a{color:red}");
    expect(css).not.toContain(".kit");
  });
});
