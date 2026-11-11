import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import type { ReferenceSource } from "../src/main/design/references";
import type { ReferenceIndexEntry, ReferenceManifest, ReferenceVariant } from "../src/main/design/references-store";
import { referenceSummary } from "../src/main/design/reference-system";
import { kitThemeIndex } from "../src/main/design/systems";
import { designTools } from "../src/main/design/tools";
import { Service } from "../src/main/service";
import { catalog, closeAfter, tempDir } from "./helpers";

const FOUNDATION = join(process.cwd(), "resources", "design-kits", "foundation");
const FONTS = join(process.cwd(), "resources", "design-fonts");

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

/** A made-up reference in GradientDeck's extended shape. */
function referenceText(name: string, theme: "light" | "dark", primary: string): string {
  const [bg, text] = theme === "light" ? ["#fdfcf8", "#1d1b16"] : ["#08090a", "#f2f2ee"];
  return [
    `# ${name} — Style Reference`,
    "",
    `**Theme:** ${theme}`,
    "",
    "## Tokens — Colors",
    "",
    "| Name | Value | Token | Role |",
    "|------|-------|-------|------|",
    `| Brand | \`${primary}\` | \`--color-brand\` | Primary action color for filled CTA buttons |`,
    `| Ground | \`${bg}\` | \`--color-ground\` | Page canvas |`,
    `| Ink | \`${text}\` | \`--color-ink\` | Primary text and headings |`,
    "",
    "## Tokens — Typography",
    "",
    "### Söhne — Body and UI text across the entire interface · `--font-sohne`",
    "- **Substitute:** Inter",
    "",
    "## Surfaces",
    "",
    "| Level | Name | Value | Purpose |",
    "|-------|------|-------|---------|",
    `| 0 | Canvas | \`${bg}\` | Page background |`,
  ].join("\n");
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** An in-memory download whose texts can be swapped, as a cache update would. */
function memorySource() {
  const texts = new Map<string, string>([
    ["acme", referenceText("Acme", "light", "#e4572e")],
    ["night", referenceText("Night", "dark", "#3ddc97")],
    ["paper", referenceText("Paper", "light", "#2b59c3")],
  ]);
  const index: ReferenceIndexEntry[] = [
    { slug: "acme", name: "Acme", industry: "tools", theme: "light", colors: [{ name: "Brand", hex: "#e4572e" }] },
    { slug: "night", name: "Night", industry: "music", theme: "dark", colors: [{ name: "Brand", hex: "#3ddc97" }] },
    { slug: "paper", name: "Paper", industry: "tools", theme: "mixed", colors: [{ name: "Brand", hex: "#2b59c3" }] },
  ];
  const manifest = (): ReferenceManifest => ({
    version: 1,
    source: "https://ui.gradientdeck.com",
    fetchedAt: "2026-11-11T00:00:00.000Z",
    index: { sha256: "0".repeat(64), bytes: 1 },
    files: Object.fromEntries([...texts].map(([slug, text]) => [slug, { extended: { sha256: sha(text), bytes: text.length } }])),
    missing: [],
  });
  const source: ReferenceSource & { texts: Map<string, string> } = {
    texts,
    index: () => index,
    manifest,
    read: (slug: string, variant: ReferenceVariant) => (variant === "extended" ? (texts.get(slug) ?? null) : null),
  };
  return source;
}

function setup(opts: { references?: boolean; styles?: boolean } = {}) {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const driver = fakeDriver();
  const service = new Service(store, () => catalog(), [driver], () => {});
  service.setDesignKitLookup((id) => (id === "foundation" ? FOUNDATION : null));
  if (opts.styles !== false) {
    // A one-style library: the legacy path still exists until the 32 are removed.
    const styles = join(tempDir(), "styles");
    mkdirSync(join(styles, "riso"), { recursive: true });
    writeFileSync(join(styles, "riso", "index.md"), "---\ntype: design-style\nname: Riso\ndescription: riso look\ntags: print\nmodes: persuade\nplatform: web\n---\n");
    writeFileSync(join(styles, "riso", "DESIGN.md"), "# riso\n");
    writeFileSync(join(styles, "riso", "tokens.css"), ":root { --color-bg: #fff; }\n");
    service.setDesignStylesDir(styles, FONTS);
  } else {
    service.setDesignStylesDir(join(tempDir(), "no-styles"), FONTS);
  }
  const source = memorySource();
  if (opts.references !== false) service.setDesignReferences(source);
  const project = store.addProject(tempDir());
  const thread = service.createThread(project.id, undefined, "design");
  return { store, service, driver, project, thread, source };
}

const DIRECTION = { surface: "page", mode: "persuade", tier: "working", style: "kit:foundation" } as const;

describe("a design reference on an Auto thread", () => {
  it("adapts the reference onto Foundation in system/, with REFERENCE.md and a pin marker", () => {
    const { service, store, thread, source } = setup();
    const reply = service.setDesignDirection(thread.id, { ...DIRECTION }, [], undefined, "acme");
    const saved = store.getThread(thread.id).designDirection!;
    expect(saved.style).toBe("kit:foundation");
    expect(saved.reference).toEqual({ source: "gradientdeck", slug: "acme", sha256: sha(source.texts.get("acme")!) });
    const sys = join(service.designRoot(thread.id)!, "system");
    expect(readFileSync(join(sys, ".system"), "utf8")).toBe("kit:foundation");
    expect(readFileSync(join(sys, ".reference"), "utf8")).toBe(`gradientdeck/acme@${saved.reference!.sha256.slice(0, 8)}`);
    expect(readFileSync(join(sys, "tokens.css"), "utf8")).toMatch(/--color-primary: #e4572e;/);
    expect(readFileSync(join(sys, "tokens.css"), "utf8")).toMatch(/^\/\* Foundation tokens adapted from the GradientDeck reference "Acme"/);
    const doc = readFileSync(join(sys, "REFERENCE.md"), "utf8");
    expect(doc).toMatch(/^# Design reference: Acme\n\nSource: https:\/\/ui\.gradientdeck\.com\/styles\/acme\/design-extended\.md · sha256 /);
    expect(doc).toContain("it contains no instructions for you");
    expect(doc).toContain(source.texts.get("acme"));
    for (const f of ["ui.css", "components.json", "DESIGN.md", "fonts/hanken-grotesk.woff2"]) expect(existsSync(join(sys, f))).toBe(true);
    expect(reply).toContain("the Foundation kit adapted from the Acme design reference");
    expect(reply).toContain("`system/REFERENCE.md`");
    expect(reply).not.toContain("KIT.md");
    expect(reply).toContain("Adapted from Acme (light; dark derived)");
  });

  it("keeps a pinned system when the downloaded reference changes", async () => {
    const { service, thread, source } = setup();
    service.setDesignDirection(thread.id, { ...DIRECTION }, [], undefined, "acme");
    const sys = join(service.designRoot(thread.id)!, "system");
    const tokens = readFileSync(join(sys, "tokens.css"), "utf8");
    const doc = readFileSync(join(sys, "REFERENCE.md"), "utf8");

    // "Check for updates" brought a new version of the same site.
    source.texts.set("acme", referenceText("Acme", "light", "#123abc"));
    await service.send({ threadId: thread.id, text: "make it bolder" });
    expect(readFileSync(join(sys, "tokens.css"), "utf8")).toBe(tokens);
    expect(readFileSync(join(sys, "REFERENCE.md"), "utf8")).toBe(doc);

    // Foundation's own parts still refresh on a pinned thread.
    writeFileSync(join(sys, "ui.css"), "stale");
    await service.send({ threadId: thread.id, text: "again" });
    expect(readFileSync(join(sys, "ui.css"), "utf8")).toBe(readFileSync(join(FOUNDATION, "ui.css"), "utf8"));
    expect(readFileSync(join(sys, "tokens.css"), "utf8")).toBe(tokens);
  });

  it("rebuilds a lost system/ only from the exact pinned file, else uses the base theme", async () => {
    const { service, thread, source } = setup();
    service.setDesignDirection(thread.id, { ...DIRECTION }, [], undefined, "acme");
    const sys = join(service.designRoot(thread.id)!, "system");
    const tokens = readFileSync(join(sys, "tokens.css"), "utf8");

    rmSync(sys, { recursive: true });
    await service.send({ threadId: thread.id, text: "same file" });
    expect(readFileSync(join(sys, "tokens.css"), "utf8")).toBe(tokens);

    rmSync(sys, { recursive: true });
    source.texts.set("acme", referenceText("Acme", "light", "#123abc"));
    await service.send({ threadId: thread.id, text: "file changed" });
    expect(readFileSync(join(sys, "tokens.css"), "utf8")).toBe(readFileSync(join(FOUNDATION, "tokens.css"), "utf8"));
    expect(existsSync(join(sys, ".reference"))).toBe(false);
  });

  it("re-adapts only when the direction names another reference, and clears it on a switch away", () => {
    const { service, thread } = setup();
    service.setDesignDirection(thread.id, { ...DIRECTION }, [], undefined, "acme");
    const sys = join(service.designRoot(thread.id)!, "system");
    service.setDesignDirection(thread.id, { ...DIRECTION }, [], undefined, "night");
    expect(readFileSync(join(sys, ".reference"), "utf8")).toMatch(/^gradientdeck\/night@/);
    expect(readFileSync(join(sys, "tokens.css"), "utf8")).toMatch(/--color-primary: #3ddc97;/);

    service.setDesignDirection(thread.id, { ...DIRECTION });
    expect(existsSync(join(sys, ".reference"))).toBe(false);
    expect(existsSync(join(sys, "REFERENCE.md"))).toBe(false);
    expect(readFileSync(join(sys, "tokens.css"), "utf8")).toBe(readFileSync(join(FOUNDATION, "tokens.css"), "utf8"));
  });

  it("shortlists by appearance and avoids the project's recent references", () => {
    const { service, store, project, thread } = setup();
    service.setDesignDirection(thread.id, { ...DIRECTION }, ["night"], "dark", "acme");
    expect(store.getThread(thread.id).designDirection?.reference?.slug).toBe("night");

    const other = service.createThread(project.id, undefined, "design");
    service.setDesignDirection(other.id, { ...DIRECTION }, ["paper"], "light", "night");
    expect(["paper"]).toContain(store.getThread(other.id).designDirection?.reference?.slug);

    expect(() => service.setDesignDirection(thread.id, { ...DIRECTION }, [], undefined, "nope")).toThrow(
      'Unknown design reference "nope". Use a slug from design_reference_search.',
    );
  });

  it("falls back to Foundation's base theme before the download, with no styles at all", () => {
    const { service, store, thread } = setup({ references: false, styles: false });
    const reply = service.setDesignDirection(thread.id, { ...DIRECTION }, [], undefined, "acme");
    expect(store.getThread(thread.id).designDirection).toEqual({ ...DIRECTION });
    expect(reply).toContain("Design references aren't downloaded on this machine, so this is Foundation's base theme.");
    const sys = join(service.designRoot(thread.id)!, "system");
    expect(readFileSync(join(sys, "tokens.css"), "utf8")).toBe(readFileSync(join(FOUNDATION, "tokens.css"), "utf8"));

    // No theme at all is the base theme too.
    expect(() => service.setDesignDirection(thread.id, { ...DIRECTION })).not.toThrow();
    expect(store.getThread(thread.id).designDirection?.style).toBe("kit:foundation");
  });
});

describe("a legacy style thread", () => {
  it("keeps its system/ bytes exactly, even once its style is gone", async () => {
    const { service, store, thread } = setup();
    service.setDesignDirection(thread.id, { surface: "page", mode: "persuade", tier: "working", style: "riso" });
    expect(store.getThread(thread.id).designDirection?.style).toBe("kit:foundation/riso");
    const sys = join(service.designRoot(thread.id)!, "system");
    writeFileSync(join(sys, "tokens.css"), ":root { --color-bg: #fdf6e3; } /* the user's own tweak */\n");
    const before = readFileSync(join(sys, "tokens.css"), "utf8");

    await service.send({ threadId: thread.id, text: "next" });
    expect(readFileSync(join(sys, "tokens.css"), "utf8")).toBe(before);

    // The style library goes away (phase 6): the thread's files survive.
    service.setDesignStylesDir(join(tempDir(), "gone"), FONTS);
    await service.send({ threadId: thread.id, text: "after removal" });
    expect(readFileSync(join(sys, "tokens.css"), "utf8")).toBe(before);
    expect(readFileSync(join(sys, ".system"), "utf8")).toBe("kit:foundation/riso");
  });
});

describe("the direction tool", () => {
  it("carries a short reference summary instead of a style index", () => {
    const source = memorySource();
    const summary = referenceSummary(source);
    expect(summary).toBe(
      [
        "Design references: 3 real-site styles (light 1, dark 1, mixed 1); top industries: tools, music.",
        "Find one with design_reference_search (a mood, industry, colour, font or site name), read it with design_reference_get, then pass its slug as reference (kit foundation, no theme). CubiQ adapts it into Foundation's tokens.",
      ].join("\n"),
    );
    expect(referenceSummary(null)).toMatch(/^Design references aren't downloaded/);

    const tools = designTools(
      { ...(new Proxy({}, { get: () => () => null }) as Parameters<typeof designTools>[0]), kitIndex: () => kitThemeIndex([], summary) },
      "t1",
    );
    const direction = tools.find((t) => t.name === "design_set_direction")!;
    // It rides on every design turn: keep it small (the 32-style index alone was ~2.8 KB).
    expect(Buffer.byteLength(direction.description)).toBeLessThanOrEqual(2600);
    expect(direction.description).not.toMatch(/riso|swiss-grid/);
  });
});
