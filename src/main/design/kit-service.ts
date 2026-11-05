import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { designDirName } from "../../shared/design";
import type { DesignKitOption, DesignMutation } from "../../shared/design-mutation";
import type { DesignIntent, DesignKitDoc, DesignKitEdit, DesignKitGroup, DesignKitPart, DesignMigrationPreview, DesignReach, DesignThemeCard, LiveUpdate, Thread } from "../../shared/types";
import { addComposition, applyKitEdit, compositionWarnings, diffManifests, freeFolder, manifestIn, partCounts, partSample, partsUsingToken, projectKitFolders, projectSystemsDir, saveKitDraft, saveSystemCopy, seedKitDraft, forkKitSystem } from "./kit-library";
import { migratePage, parseMigrations, type MigrationPlan } from "./kit-migrate";
import { validateKitDir } from "./kit-schema";
import { listDesignPages } from "./pages";
import { listDesignSystems, listKitSystems, materializeSystem, type DesignStyleInfo, type DesignSystemInfo } from "./systems";
import { parseTokens } from "./tokens";

/** What the kit features need from the app; injected so they run in plain Node. */
export interface KitServiceDeps {
  getThread(threadId: string): Thread;
  threadsOf(projectId: string | null): Thread[];
  setDesignSystem(threadId: string, id: string): Thread;
  projectPath(projectId: string | null): string | null;
  designRoot(threadId: string): string | null;
  /** The system a thread is on, with its files. */
  threadSystem(thread: Thread): DesignSystemInfo | null;
  /** A system by id, kits included. */
  systemById(projectId: string | null, id: string): DesignSystemInfo | null;
  /** The kit's own system (`kit:<id>`). */
  styles(): DesignStyleInfo[];
  kitDir(kitId: string): string | null;
  broadcast(update: LiveUpdate): void;
}

/** The page edit service, set once it exists. */
export interface KitDocuments {
  text(threadId: string, rel: string, file: string): string;
  apply(threadId: string, rel: string, file: string, target: DesignMutation["target"], changes: DesignMutation["change"][]): { ok: true } | { ok: false; message: string };
}

const ROOT: DesignMutation["target"] = { locator: { tag: "html", path: [] } };
const PREVIEW = ".preview";
/** How many System mode edits one thread can step back through. */
const MAX_UNDO = 30;

interface Snapshot {
  label: string;
  dir: string;
  before: Map<string, string | null>;
  after: Map<string, string | null>;
}

/** A kit move that can still be undone with its page. */
interface Move {
  rel: string;
  before: string;
  after: string;
  from: string | null;
  to: string;
}

const SNAPSHOT_FILES = ["tokens.css", "components.json", "ui.css", "DESIGN.md"];

function read(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The theme's look, from its own tokens. */
export function themeCard(system: DesignSystemInfo, mine: boolean): DesignThemeCard {
  const groups = parseTokens((system.tokensCss && read(system.tokensCss)) || "");
  const tokens = new Map(groups.flatMap((g) => g.tokens.map((t) => [t.name, t] as const)));
  const light = (name: string): string | undefined => tokens.get(name)?.light || undefined;
  const dark = (name: string): string | undefined => tokens.get(name)?.dark ?? undefined;
  const accent = light("--color-primary") ?? light("--color-accent") ?? "#555555";
  const card: DesignThemeCard["card"] = {
    bg: light("--color-bg") ?? "#ffffff",
    surface: light("--color-surface") ?? light("--color-bg") ?? "#ffffff",
    text: light("--color-text") ?? "#111111",
    muted: light("--color-text-muted") ?? light("--color-text") ?? "#666666",
    accent,
    onAccent: light("--color-on-primary") ?? "#ffffff",
    border: light("--color-border") ?? "#dddddd",
    radius: light("--radius-md") ?? "8px",
    font: light("--font-display") ?? light("--font-sans") ?? "inherit",
  };
  if (dark("--color-bg")) {
    card.dark = {
      bg: dark("--color-bg")!,
      surface: dark("--color-surface") ?? dark("--color-bg")!,
      text: dark("--color-text") ?? "#eeeeee",
      muted: dark("--color-text-muted") ?? dark("--color-text") ?? "#999999",
      accent: dark("--color-primary") ?? dark("--color-accent") ?? accent,
      onAccent: dark("--color-on-primary") ?? card.onAccent,
      border: dark("--color-border") ?? "#333333",
    };
  }
  return { id: system.id, name: system.name, description: system.description, swatches: system.swatches, ...(system.facets ? { facets: system.facets } : {}), card, mine };
}

/** The moves a plan makes, as the preview shows them. */
function previewOf(plan: MigrationPlan, target: DesignSystemInfo, previewRel: string, pages: number): DesignMigrationPreview {
  const kitName = target.kit ? manifestIn(target.kit.dir)?.name : undefined;
  return { targetId: target.id, targetName: kitName && kitName !== target.name ? `${kitName} · ${target.name}` : target.name, previewRel, same: plan.same, renamed: plan.renamed, unsupported: plan.unsupported, droppedProps: plan.droppedProps, review: plan.review, pages };
}

/**
 * Kits and themes for one app: the picker's lists, theme switches and kit moves, the project's own copies, and the
 * deterministic edits System mode makes. Every path that changes a kit writes to the project's folder, never to a
 * bundled or installed kit; the agent reaches the project only through `save`, so the fence stays as strict as it was.
 */
export class DesignKitService {
  private documents: KitDocuments | null = null;
  private pageFile: ((threadId: string, rel: string) => string | null) | null = null;
  private catalog: () => DesignKitOption[] = () => [];
  private readonly notes = new Map<string, string>();
  private readonly undo = new Map<string, Snapshot[]>();
  private readonly redo = new Map<string, Snapshot[]>();
  private readonly moves = new Map<string, Move[]>();

  constructor(private readonly deps: KitServiceDeps) {}

  /** Bind what only exists once the app has started. */
  connect(o: { documents: KitDocuments; pageFile: (threadId: string, rel: string) => string | null; catalog: () => DesignKitOption[] }): void {
    this.documents = o.documents;
    this.pageFile = o.pageFile;
    this.catalog = o.catalog;
  }

  /** The kit's base system (`kit:<id>`), or null when it isn't on this machine. */
  private baseSystem(kitId: string): DesignSystemInfo | null {
    const dir = this.deps.kitDir(kitId);
    return dir ? (listKitSystems(dir, this.deps.styles())[0] ?? null) : null;
  }

  /** Every kit and its themes. Cards never mix kits: the renderer shows one group at a time. */
  groups(projectId: string | null): DesignKitGroup[] {
    const project = this.deps.projectPath(projectId);
    const own = project ? listDesignSystems(project) : [];
    const groups: DesignKitGroup[] = [];
    const counts = (dir: string): { components: number; blocks: number } => {
      const manifest = manifestIn(dir);
      let blocks = 0;
      try {
        blocks = readdirSync(join(dir, "blocks")).filter((f) => f.endsWith(".html")).length;
      } catch {
        // A kit may have no blocks.
      }
      return { components: manifest?.components.length ?? 0, blocks };
    };
    for (const option of this.catalog()) {
      const dir = option.installed ? this.deps.kitDir(option.id) : null;
      const systems = dir ? listKitSystems(dir, this.deps.styles()) : [];
      groups.push({
        id: option.id,
        name: option.name,
        version: option.version,
        bundled: option.bundled,
        installed: option.installed && systems.length > 0,
        mine: false,
        ...(dir ? counts(dir) : { components: 0, blocks: 0 }),
        themes: systems.filter((s) => s.tokensCss).map((s) => themeCard(s, false)),
      });
    }
    for (const system of own) {
      if (!system.tokensCss) continue;
      const kitId = system.kit?.id ?? "foundation";
      const group = groups.find((g) => g.id === kitId);
      if (group) {
        group.themes.unshift(themeCard(system, true));
        continue;
      }
      const manifest = system.kit ? manifestIn(system.kit.dir) : null;
      groups.push({ id: kitId, name: manifest?.name ?? system.name, version: manifest?.version ?? "1.0.0", bundled: false, installed: true, mine: true, ...(system.kit ? counts(system.kit.dir) : { components: 0, blocks: 0 }), themes: [themeCard(system, true)] });
    }
    return groups;
  }

  /** Copy a thread's new system in right away, so the frame shows it now rather than on the next turn. */
  private switchTo(threadId: string, id: string): Thread {
    const thread = this.deps.setDesignSystem(threadId, id);
    const root = this.deps.designRoot(threadId);
    const system = this.deps.threadSystem(thread);
    if (root && system) materializeSystem(system, join(root, "system"));
    this.deps.broadcast({ type: "thread", thread });
    return thread;
  }

  /** Swap to another theme of the same kit. Only tokens change, so the agent hears a short note and nothing is rebuilt. */
  applyTheme(threadId: string, id: string): { thread: Thread; previous: string | null } {
    const before = this.deps.getThread(threadId);
    if (before.kind !== "design") throw new Error("Only a design thread has a theme.");
    const target = this.deps.systemById(before.projectId, id);
    if (!target) throw new Error("That theme isn't available.");
    const current = this.deps.threadSystem(before);
    const from = current?.kit?.id ?? "foundation";
    if ((target.kit?.id ?? "foundation") !== from || !this.compatible(current, target)) throw new Error("That theme is in another kit, so the page has to move to it first.");
    // An Auto thread's undo goes back to the look it had: switching to Auto itself would drop what it picked.
    const previous = current?.id ?? before.designSystem ?? null;
    const thread = this.switchTo(threadId, id);
    this.addNote(threadId, `the theme is now ${target.name}: tokens only, nothing to rebuild. Read \`system/DESIGN.md\` again before you change the page.`);
    return { thread, previous };
  }

  /** Same major contract: the kit's markup still means the same thing. */
  private compatible(a: DesignSystemInfo | null, b: DesignSystemInfo): boolean {
    if (!a?.kit || !b.kit) return true;
    return a.kit.contractVersion.split(".")[0] === b.kit.contractVersion.split(".")[0];
  }

  private plan(threadId: string, rel: string, target: DesignSystemInfo, thread: Thread): MigrationPlan {
    const file = this.pageFile?.(threadId, rel);
    if (!file || !this.documents) throw new Error("No such page.");
    if (!target.kit) throw new Error("That style has no components to move to.");
    const toManifest = manifestIn(target.kit.dir);
    if (!toManifest) throw new Error("That kit couldn't be read.");
    const current = this.deps.threadSystem(thread);
    const fromManifest = current?.kit ? manifestIn(current.kit.dir) : null;
    return migratePage(this.documents.text(threadId, rel, file), fromManifest, toManifest, parseMigrations(read(join(target.kit.dir, "migrations.json"))));
  }

  /** Work out and render a move, changing nothing the user can see: the preview lives in a hidden folder. */
  migrationPreview(threadId: string, rel: string, id: string): DesignMigrationPreview {
    const thread = this.deps.getThread(threadId);
    const root = this.deps.designRoot(threadId);
    const target = this.deps.systemById(thread.projectId, id);
    if (!root || !target) throw new Error("That kit isn't available.");
    const plan = this.plan(threadId, rel, target, thread);
    this.cancelMigration(threadId);
    materializeSystem(target, join(root, PREVIEW, "system"));
    const previewRel = `${PREVIEW}-page.html`;
    writeFileSync(join(root, previewRel), plan.html.replace(/((?:href|src)\s*=\s*["'])(?:\.\/)?system\//g, `$1${PREVIEW}/system/`));
    return previewOf(plan, target, previewRel, listDesignPages(root).length);
  }

  cancelMigration(threadId: string): void {
    const root = this.deps.designRoot(threadId);
    if (!root) return;
    rmSync(join(root, PREVIEW), { recursive: true, force: true });
    rmSync(join(root, `${PREVIEW}-page.html`), { force: true });
    rmSync(join(root, `${PREVIEW}-part.html`), { force: true });
  }

  /** Move every page of the design, each as one undo step, then the system. Undoing the open page brings the rest back. */
  commitMigration(threadId: string, rel: string, id: string): { thread: Thread } {
    const before = this.deps.getThread(threadId);
    const root = this.deps.designRoot(threadId);
    const target = this.deps.systemById(before.projectId, id);
    if (!root || !target || !this.documents) throw new Error("That kit isn't available.");
    const moved: Move[] = [];
    const pages = listDesignPages(root);
    for (const page of [rel, ...pages.filter((p) => p !== rel)]) {
      const file = this.pageFile?.(threadId, page);
      if (!file) continue;
      const original = this.documents.text(threadId, page, file);
      const plan = this.plan(threadId, page, target, before);
      if (!plan.changed) {
        moved.push({ rel: page, before: original, after: original, from: before.designSystem ?? null, to: id });
        continue;
      }
      const done = this.documents.apply(threadId, page, file, ROOT, [{ kind: "replaceDocument", html: plan.html }]);
      if (!done.ok) throw new Error(`${page}: ${done.message}`);
      moved.push({ rel: page, before: original, after: plan.html, from: before.designSystem ?? null, to: id });
    }
    this.moves.set(threadId, moved);
    const thread = this.switchTo(threadId, id);
    this.cancelMigration(threadId);
    // Its own saves don't reload the frame, and this one changed what the frame shows.
    this.deps.broadcast({ type: "design-changed", threadId, paths: [rel] });
    const unsupported = moved.length ? this.plan(threadId, rel, target, thread).unsupported.length : 0;
    this.addNote(threadId, `this design moved to the ${target.name} kit: \`system/\` was replaced and each page's \`data-ui\` renamed by table. Read \`system/DESIGN.md\` and \`system/components.json\` before you change a page${unsupported ? `; ${unsupported} part${unsupported === 1 ? " has" : "s have"} no match and stayed as written` : ""}.`);
    return { thread };
  }

  /**
   * A page's undo or redo just landed. When that crossed a kit move, the system goes with it, and the other pages too;
   * returns those pages so the caller can step them the same way.
   */
  afterHistory(threadId: string, rel: string, html: string, action: "undo" | "redo"): string[] {
    const moved = this.moves.get(threadId);
    const hit = moved?.find((m) => m.rel === rel);
    if (!moved || !hit) return [];
    const crossed = action === "undo" ? html === hit.before && hit.before !== hit.after : html === hit.after && hit.before !== hit.after;
    if (!crossed) return [];
    const to = action === "undo" ? hit.from : hit.to;
    if (to) this.switchTo(threadId, to);
    return moved.filter((m) => m.rel !== rel && m.before !== m.after).map((m) => m.rel);
  }

  /** Save the look as the project's own theme, and put the thread on it. `sourceId` is `Customize a copy` from the picker. */
  saveTheme(threadId: string, name: string, tokens: Record<string, string>, sourceId?: string): { thread: Thread; id: string; applied: string[] } {
    const before = this.deps.getThread(threadId);
    const project = this.deps.projectPath(before.projectId);
    if (!project) throw new Error("Open a project folder to save a theme.");
    const source = sourceId ? this.deps.systemById(before.projectId, sourceId) : this.deps.threadSystem(before);
    if (!source) throw new Error("This design has no style to save yet.");
    const saved = saveSystemCopy(source, project, name, tokens);
    const thread = this.switchTo(threadId, saved.id);
    const tokensCss = saved.tokensCss ? read(saved.tokensCss) ?? "" : "";
    const known = new Set(parseTokens(tokensCss).flatMap((g) => g.tokens.map((t) => t.name)));
    return { thread, id: saved.id, applied: Object.keys(tokens).filter((t) => known.has(t)) };
  }

  /** The kit folder a change is written to: the project's copy, made on the first edit. */
  private writableKit(threadId: string): { system: DesignSystemInfo; thread: Thread } {
    let thread = this.deps.getThread(threadId);
    const current = this.deps.threadSystem(thread);
    if (!current?.kit) throw new Error("This design has no kit. Pick one in Style first.");
    if (current.source !== "kit") return { system: current, thread };
    const project = this.deps.projectPath(thread.projectId);
    if (!project) throw new Error("Open a project folder to change a kit.");
    const copy = forkKitSystem(current, project);
    thread = this.deps.setDesignSystem(threadId, copy.id);
    this.deps.broadcast({ type: "thread", thread });
    return { system: copy, thread };
  }

  /** Run a change to a kit folder as one undo step, then send it to every design on that system. */
  private snapshot<T>(threadId: string, label: string, system: DesignSystemInfo, change: () => T): T {
    const dir = system.kit?.dir ?? (system.tokensCss ? join(system.tokensCss, "..") : null);
    if (!dir) return change();
    const capture = (): Map<string, string | null> => new Map(SNAPSHOT_FILES.map((f) => [f, read(join(dir, f))]));
    const before = capture();
    const result = change();
    const stack = this.undo.get(threadId) ?? [];
    stack.push({ label, dir, before, after: capture() });
    this.undo.set(threadId, stack.slice(-MAX_UNDO));
    this.redo.delete(threadId);
    this.syncUsers(threadId, system);
    return result;
  }

  /** Record a token edit the service made itself. */
  recordSystemEdit<T>(threadId: string, label: string, system: DesignSystemInfo, change: () => T): T {
    return this.snapshot(threadId, label, system, change);
  }

  /** The other designs in the project on this system follow it now; their open canvases reload from the watcher. */
  private syncUsers(threadId: string, system: DesignSystemInfo): void {
    const thread = this.deps.getThread(threadId);
    for (const other of this.deps.threadsOf(thread.projectId)) {
      if (other.kind !== "design") continue;
      if (other.id !== threadId && other.designSystem !== system.id) continue;
      const root = this.deps.designRoot(other.id);
      if (!root) continue;
      try {
        materializeSystem(system, join(root, "system"));
      } catch {
        // Its next turn copies it again.
      }
    }
  }

  /** Step through this thread's System mode edits. Returns null when there's nothing to step to. */
  history(threadId: string, action: "undo" | "redo"): { label: string; thread: Thread } | null {
    const from = action === "undo" ? this.undo : this.redo;
    const to = action === "undo" ? this.redo : this.undo;
    const stack = from.get(threadId);
    const step = stack?.pop();
    if (!step) return null;
    const files = action === "undo" ? step.before : step.after;
    for (const [name, text] of files) {
      if (text === null) rmSync(join(step.dir, name), { force: true });
      else writeFileSync(join(step.dir, name), text);
    }
    to.set(threadId, [...(to.get(threadId) ?? []), step]);
    const thread = this.deps.getThread(threadId);
    const system = this.deps.threadSystem(thread);
    if (system) this.syncUsers(threadId, system);
    return { label: step.label, thread };
  }

  /** Every design thread on this kit, and its pages. */
  private pagesOnKit(thread: Thread, kitId: string | null, systemId: string | null): { html: string }[] {
    const out: { html: string }[] = [];
    for (const other of this.deps.threadsOf(thread.projectId)) {
      if (other.kind !== "design") continue;
      const system = this.deps.threadSystem(other);
      if (kitId ? system?.kit?.id !== kitId : system?.id !== systemId) continue;
      const root = this.deps.designRoot(other.id);
      if (!root) continue;
      for (const page of listDesignPages(root)) {
        const html = read(join(root, page));
        if (html !== null) out.push({ html });
      }
    }
    return out;
  }

  /** What changing these tokens would reach, across the project's designs on this kit or style. */
  reach(threadId: string, tokens: string[]): DesignReach {
    const thread = this.deps.getThread(threadId);
    const system = this.deps.threadSystem(thread);
    const pages = this.pagesOnKit(thread, system?.kit?.id ?? null, system?.id ?? null);
    const css = system?.kit ? read(join(system.kit.dir, "ui.css")) ?? "" : "";
    const parts = new Set(tokens.flatMap((t) => [...partsUsingToken(css, t)]));
    let instances = 0;
    let files = 0;
    for (const { html } of pages) {
      let here = 0;
      for (const [ui, n] of partCounts(html)) if (parts.has(ui)) here += n;
      for (const t of tokens) here += html.split(`var(${t}`).length - 1;
      instances += here;
      if (here) files += 1;
    }
    return { tokens: tokens.length, instances, files };
  }

  /** The thread's `kit/` draft against the kit it's on, or null when it holds nothing new. */
  private draftOf(thread: Thread, root: string | null, system: DesignSystemInfo | null): { doc: DesignKitDoc["draft"]; parts: DesignKitPart[] } {
    if (!root) return { doc: null, parts: [] };
    const draftDir = join(root, "kit");
    const draft = manifestIn(draftDir);
    if (!draft) return { doc: null, parts: [] };
    const base = system?.kit ? manifestIn(system.kit.dir) : null;
    const diff = diffManifests(base, draft);
    const sameCss = system?.kit ? read(join(draftDir, "ui.css")) === read(join(system.kit.dir, "ui.css")) : false;
    const sameTokens = system?.tokensCss ? read(join(draftDir, "tokens.css")) === read(system.tokensCss) : false;
    const renamed = base !== null && base.kitId !== draft.kitId;
    const changed = [...diff.changed, ...(sameCss ? [] : ["ui.css"]), ...(sameTokens ? [] : ["tokens.css"])];
    if (!diff.added.length && !diff.removed.length && !changed.length && !renamed) return { doc: null, parts: [] };
    const verdict = validateKitDir(draftDir);
    const parts = draft.components.filter((c) => diff.added.includes(c.ui)).map((c) => toPart(c, draft.package ?? null, new Map(), true));
    return { doc: { added: diff.added, changed, removed: diff.removed, errors: verdict.ok ? [] : verdict.errors }, parts };
  }

  /** The kit behind a thread, with where each part is used. */
  doc(threadId: string): DesignKitDoc {
    const thread = this.deps.getThread(threadId);
    const system = this.deps.threadSystem(thread);
    const root = this.deps.designRoot(threadId);
    const project = this.deps.projectPath(thread.projectId);
    const draft = this.draftOf(thread, root, system);
    const editable = system?.source === "style" || system?.source === "kit" ? project !== null : system !== null;
    const base = { copyOnWrite: system?.source === "kit" || system?.source === "style", editable, draft: draft.doc };
    const manifest = system?.kit ? manifestIn(system.kit.dir) : null;
    if (!manifest || !system?.kit) return { kit: null, parts: draft.parts, blocks: [], ...base };
    const usage = new Map<string, { count: number; files: number }>();
    for (const { html } of this.pagesOnKit(thread, system.kit.id, null)) {
      for (const [ui, n] of partCounts(html)) {
        const at = usage.get(ui) ?? { count: 0, files: 0 };
        usage.set(ui, { count: at.count + n, files: at.files + 1 });
      }
    }
    let blocks: string[] = [];
    try {
      blocks = readdirSync(join(system.kit.dir, "blocks")).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5)).sort();
    } catch {
      // A kit may have no blocks.
    }
    return {
      kit: { id: system.kit.id, name: manifest.name, version: manifest.version },
      parts: [...draft.parts, ...manifest.components.map((c) => toPart(c, manifest.package ?? null, usage, false))],
      blocks,
      ...base,
    };
  }

  /** Render one part into a hidden page in the design folder, in a matrix of its variants or with the props given. */
  sample(threadId: string, request: { ui: string; matrix?: boolean; props?: Record<string, string> }): string {
    const thread = this.deps.getThread(threadId);
    const root = this.deps.designRoot(threadId);
    const system = this.deps.threadSystem(thread);
    if (!root) throw new Error("This thread has no design folder.");
    const draft = manifestIn(join(root, "kit"));
    const inKit = system?.kit ? manifestIn(system.kit.dir)?.components.find((c) => c.ui === request.ui) : undefined;
    const inDraft = draft?.components.find((c) => c.ui === request.ui);
    const part = inKit ?? inDraft;
    if (!part) throw new Error("That component isn't in the kit.");
    const folder = inKit ? "system" : "kit";
    const rel = `${PREVIEW}-part.html`;
    writeFileSync(join(root, rel), partSample(part, folder, request));
    return rel;
  }

  edit(threadId: string, edit: DesignKitEdit): { doc: DesignKitDoc; thread: Thread } {
    const { system, thread } = this.writableKit(threadId);
    const label =
      edit.kind === "addVariant" ? `Added variant ${edit.name}` : edit.kind === "removeVariant" ? `Removed variant ${edit.name}` : edit.kind === "addProp" ? `Added prop ${edit.prop.name}` : edit.kind === "removeProp" ? `Removed prop ${edit.name}` : edit.kind === "removeComponent" ? `Removed ${edit.ui}` : `Reviewed ${edit.ui}`;
    this.snapshot(threadId, label, system, () => applyKitEdit(system.kit!.dir, edit));
    return { doc: this.doc(threadId), thread };
  }

  /** The folder a draft of this kit saves to: the thread's own copy, another copy of it, or a new folder. */
  private saveTarget(thread: Thread, project: string, kitId: string): string {
    const current = this.deps.threadSystem(thread);
    if (current?.source === "projectFolder" && current.kit?.id === kitId) return current.id.slice("project:".length);
    const existing = projectKitFolders(project, kitId)[0];
    if (existing) return existing;
    return freeFolder(projectSystemsDir(project), current?.kit?.id === kitId ? `${kitId}-custom` : kitId);
  }

  private saveDraft(threadId: string, markNew: boolean): { thread: Thread; added: string[]; removed: string[]; name: string; errors: string[] } {
    const before = this.deps.getThread(threadId);
    const root = this.deps.designRoot(threadId);
    const project = this.deps.projectPath(before.projectId);
    if (!root) throw new Error("This thread has no design folder.");
    if (!project) throw new Error("Open a project folder to save a kit. The draft stays in this thread until then.");
    const draftDir = join(root, "kit");
    const manifest = manifestIn(draftDir);
    if (!manifest) {
      const verdict = validateKitDir(draftDir);
      return { thread: before, added: [], removed: [], name: "", errors: verdict.ok ? ["kit/components.json can't be read."] : verdict.errors };
    }
    const current = this.deps.threadSystem(before);
    const foundation = this.deps.kitDir("foundation");
    const base = (current?.kit && manifestIn(current.kit.dir)) || (foundation ? manifestIn(foundation) : null);
    const folder = this.saveTarget(before, project, manifest.kitId);
    const result = saveKitDraft(draftDir, project, folder, { markNew, base });
    if (!result.ok) return { thread: before, added: [], removed: [], name: manifest.name, errors: result.errors };
    const thread = this.switchTo(threadId, `project:${folder}`);
    return { thread, added: result.diff.added, removed: result.diff.removed, name: manifest.name, errors: [] };
  }

  /** The agent's `design_kit_save`. */
  saveForAgent(threadId: string): string {
    const done = this.saveDraft(threadId, true);
    if (done.errors.length) throw new Error(`The kit wasn't saved. Fix these in kit/, then call it again:\n- ${done.errors.slice(0, 20).join("\n- ")}`);
    const names = done.added.length ? ` New: ${done.added.join(", ")}.` : "";
    return `Saved ${done.name}. \`system/\` now holds it: build with \`system/ui.css\` and its parts.${names} To add more later, edit \`kit/\` and save again.`;
  }

  /** `Save to kit`: a reviewed draft. Nothing it adds is marked new, since the user just looked at it. */
  saveForUser(threadId: string): { doc: DesignKitDoc; thread: Thread } {
    const done = this.saveDraft(threadId, false);
    if (done.errors.length) throw new Error(done.errors[0]);
    return { doc: this.doc(threadId), thread: done.thread };
  }

  discardDraft(threadId: string): DesignKitDoc {
    const root = this.deps.designRoot(threadId);
    if (root) rmSync(join(root, "kit"), { recursive: true, force: true });
    return this.doc(threadId);
  }

  /** Keep a selection as a block of the kit, without an agent turn. */
  saveComposition(threadId: string, name: string, html: string, force: boolean): { warnings: string[]; saved: string | null; thread: Thread } {
    const warnings = compositionWarnings(html);
    if (warnings.length && !force) return { warnings, saved: null, thread: this.deps.getThread(threadId) };
    const { system, thread } = this.writableKit(threadId);
    const { ui } = this.snapshot(threadId, `Saved ${name}`, system, () => addComposition(system.kit!.dir, name, html));
    return { warnings, saved: ui, thread };
  }

  /** The agent's `design_tokens_apply`: only values of tokens the page's system already has, as one undo step. */
  applyTokens(threadId: string, rel: string, tokens: Record<string, string>): string {
    const root = this.deps.designRoot(threadId);
    const file = this.pageFile?.(threadId, rel);
    if (!root || !file || !this.documents) throw new Error("No such page.");
    const css = read(join(root, "system", "tokens.css"));
    if (css === null) throw new Error("This design has no system/tokens.css yet. Call design_set_direction first.");
    const known = new Set(parseTokens(css).flatMap((g) => g.tokens.map((t) => t.name)));
    const entries = Object.entries(tokens);
    if (!entries.length) throw new Error("No tokens given.");
    const unknown = entries.filter(([name]) => !known.has(name)).map(([name]) => name);
    if (unknown.length) throw new Error(`system/tokens.css has no ${unknown.join(", ")}. Nothing was changed.`);
    const bad = entries.filter(([, value]) => !value.trim() || value.length > 200 || /[;{}\r\n]/.test(value)).map(([name]) => name);
    if (bad.length) throw new Error(`Bad value for ${bad.join(", ")}. Nothing was changed.`);
    // setStyle takes 32 at a time; they stay one undo step because they share a transaction.
    const changes: DesignMutation["change"][] = [];
    for (let i = 0; i < entries.length; i += 32) {
      changes.push({ kind: "setStyle", changes: entries.slice(i, i + 32).map(([prop, value]) => ({ prop, value: value.trim() })) });
    }
    const done = this.documents.apply(threadId, rel, file, ROOT, changes);
    if (!done.ok) throw new Error(done.message);
    this.deps.broadcast({ type: "design-changed", threadId, paths: [rel] });
    return `${entries.length} token${entries.length === 1 ? "" : "s"} changed on ${rel}, no components touched. The user can undo it in one step and save it as a theme.`;
  }

  /** What `design_kit_inspect` says. */
  inspect(threadId: string, query: { kit?: string; component?: string; block?: string; startDraft?: boolean }): string {
    const thread = this.deps.getThread(threadId);
    const root = this.deps.designRoot(threadId);
    const current = this.deps.threadSystem(thread);
    if (query.startDraft) {
      if (!root) throw new Error("This thread has no design folder.");
      const from = current?.kit ? current : this.baseSystem("foundation");
      if (!from) throw new Error("There's no kit to start from.");
      const made = seedKitDraft(from, join(root, "kit"));
      return made ? `\`kit/\` is now a copy of ${from.name}. Edit it there, then save.` : "`kit/` already holds a draft. Edit it there, then save.";
    }
    const kitId = query.kit ?? current?.kit?.id ?? null;
    const own = current?.kit && current.kit.id === kitId ? current.kit.dir : null;
    const dir = kitId ? (own ?? this.deps.kitDir(kitId)) : null;
    if (kitId && !dir) throw new Error(`The kit ${kitId} isn't on this machine.`);
    if (!dir) return `This design is on a flat style with tokens only (${current?.name ?? "none yet"}). Compose from its tokens.`;
    const manifest = manifestIn(dir);
    if (!manifest) throw new Error(`The kit ${kitId} couldn't be read.`);
    if (query.component) {
      const part = manifest.components.find((c) => c.ui === query.component);
      if (!part) throw new Error(`${manifest.name} has no ${query.component}. Parts: ${manifest.components.map((c) => c.ui).join(", ")}.`);
      const props = part.props.map((p) => `- data-${p.name}: ${p.type === "choice" ? (p.options ?? []).join(" | ") : p.type}${p.default !== undefined ? ` (default ${String(p.default)})` : ""}`).join("\n");
      const imported = part.import ? `\nReal import: ${part.import.name} from ${part.import.package}` : "";
      return `${part.name} (data-ui="${part.ui}"). ${part.description ?? ""}${imported}\nProps:\n${props || "- none"}\nSnippet:\n${part.snippet}`;
    }
    if (query.block) {
      const safe = query.block.replace(/[^a-z0-9-]/gi, "");
      const html = read(join(dir, "blocks", `${safe}.html`));
      if (html === null) throw new Error(`${manifest.name} has no block ${query.block}.`);
      return html;
    }
    const byCategory = new Map<string, string[]>();
    for (const c of manifest.components) {
      const key = c.category ?? "Other";
      byCategory.set(key, [...(byCategory.get(key) ?? []), c.ui]);
    }
    let blocks: string[] = [];
    try {
      blocks = readdirSync(join(dir, "blocks")).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5));
    } catch {
      // A kit may have no blocks.
    }
    const others = this.catalog().filter((k) => k.installed && k.id !== kitId).map((k) => k.id);
    return [
      `${manifest.name} ${manifest.version}${manifest.package ? `, modelled on ${manifest.package}` : ""}`,
      ...[...byCategory].map(([category, list]) => `${category}: ${list.join(", ")}`),
      blocks.length ? `Blocks: ${blocks.join(", ")}` : "",
      others.length ? `Also on this machine: ${others.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** A choice from the Composer: said on the next turn, with `kit/` ready when the choice needs it. */
  setIntent(threadId: string, intent: DesignIntent | null): void {
    if (!intent) {
      this.intents.delete(threadId);
      return;
    }
    this.intents.set(threadId, intent);
  }

  private readonly intents = new Map<string, DesignIntent>();

  private addNote(threadId: string, text: string): void {
    const prior = this.notes.get(threadId);
    this.notes.set(threadId, prior ? `${prior} ${text}` : text);
  }

  /** What the next turn is told once, with the deterministic set-up it needs done first. */
  takeNote(thread: Thread): string {
    const said: string[] = [];
    const note = this.notes.get(thread.id);
    if (note) said.push(note);
    this.notes.delete(thread.id);
    this.dropSpentDraft(thread);
    const intent = this.intents.get(thread.id);
    this.intents.delete(thread.id);
    if (intent) said.push(this.prepareIntent(thread, intent));
    const text = said.filter(Boolean).join(" ");
    return text ? `\n\n(CubiQ: ${text})` : "";
  }

  /** A draft already saved is gone before the turn, so a stale copy can't overwrite a later edit. */
  private dropSpentDraft(thread: Thread): void {
    const root = this.deps.designRoot(thread.id);
    if (!root || !existsSync(join(root, "kit"))) return;
    const fresh = this.deps.getThread(thread.id);
    if (this.draftOf(fresh, root, this.deps.threadSystem(fresh)).doc === null) rmSync(join(root, "kit"), { recursive: true, force: true });
  }

  private prepareIntent(thread: Thread, intent: DesignIntent): string {
    const root = this.deps.designRoot(thread.id);
    const folder = designDirName(thread.id);
    if (!root) return "";
    if (intent.kind === "match-screenshot") {
      return `the user chose Match a screenshot. Load the \`design-kit\` skill and follow its screenshot path: read the attached image in \`${folder}/refs/\`, then call design_tokens_apply. Change no markup.`;
    }
    const current = this.deps.threadSystem(thread);
    const foundation = this.baseSystem("foundation");
    if (intent.kind === "new-kit") {
      if (!foundation) return "the user chose Start a new kit, but Foundation is missing, so say that and stop.";
      // Agent's next call is the kit's, so the thread needs no Auto direction first.
      if (thread.designSystem === "auto" || !current) this.switchTo(thread.id, foundation.id);
      seedKitDraft(foundation, join(root, "kit"), { kitId: "my-kit", name: intent.name ?? "My kit" });
      return `the user chose Start a new kit. \`${folder}/kit/\` is a copy of Foundation. Load the \`design-kit\` skill and follow its new-kit path.`;
    }
    const from = current?.kit ? current : foundation;
    if (!from) return "";
    seedKitDraft(from, join(root, "kit"));
    if (intent.kind === "new-component") {
      const start = intent.selection ? ` Start from this selection:\n${intent.selection.slice(0, 2000)}\n` : " ";
      return `the user chose New component.${start}\`${folder}/kit/\` is a draft copy of ${from.name}. Load the \`design-kit\` skill and follow its new-component path. Don't call design_kit_save: they review it first.`;
    }
    return `this message is about the design system, not the page (${intent.where}). \`${folder}/kit/\` is a draft copy of ${from.name}: change that, not the pages. Load the \`design-kit\` skill. Don't call design_kit_save: they review it first.`;
  }
}

function toPart(c: NonNullable<ReturnType<typeof manifestIn>>["components"][number], packageName: string | null, usage: Map<string, { count: number; files: number }>, draft: boolean): DesignKitPart {
  return {
    ui: c.ui,
    name: c.name,
    category: c.category ?? "Other",
    kind: c.kind,
    description: c.description ?? "",
    props: c.props.map((p) => ({ name: p.name, label: p.label, type: p.type, ...(p.options ? { options: p.options } : {}), ...(p.default !== undefined ? { default: p.default } : {}) })),
    snippet: c.snippet,
    importName: c.import?.name ?? null,
    packageName: c.import?.package ?? packageName,
    isNew: c.status === "new",
    draft,
    usage: usage.get(c.ui) ?? { count: 0, files: 0 },
  };
}

