import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { findRemoteUrls, parseKitManifest, validateKitDir, type KitManifest } from "./kit-schema";
import { listDesignSystems, type DesignSystemInfo } from "./systems";
import { parseTokens, setToken } from "./tokens";
import type { DesignKitSampleRequest } from "../../shared/types";

/**
 * A project's own kits and themes: copies under `.agents/design-systems/`, the folder `listDesignSystems` already
 * reads, so anything saved here is in the picker at once and travels with the project's git. Nothing here runs kit
 * content; it only copies and rewrites text.
 */

/** Where a project keeps its own design systems. */
export function projectSystemsDir(projectPath: string): string {
  return join(projectPath, ".agents", "design-systems");
}

/** A folder and id slug for a name, or "" when the name has nothing usable in it. */
export function systemSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/** `base`, or `base-2`, `base-3`… when that folder is taken. */
export function freeFolder(root: string, base: string): string {
  if (!existsSync(join(root, base))) return base;
  for (let n = 2; ; n++) {
    const next = `${base}-${n}`;
    if (!existsSync(join(root, next))) return next;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Frontmatter values stay on one line, so a name can't add a field. */
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

/** The kit parts that travel with a copy. Themes don't: a copy is one look. */
const KIT_PARTS = ["ui.css", "ui.js", "components.json", "migrations.json"] as const;

/** Put `build` in `dest` all at once: built beside it, so a failure leaves nothing half written. */
function buildFolder(dest: string, build: (staging: string) => void): void {
  const parent = join(dest, "..");
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.staging-${basename(dest)}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    build(staging);
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** The manifest text for a kit that now stands on its own: its themes stayed behind. */
function ownManifest(text: string, change?: (m: Record<string, unknown>) => void): string {
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const compat = (manifest.compat ?? {}) as Record<string, unknown>;
  manifest.compat = { ...compat, themes: [] };
  change?.(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Tokens `overrides` can change, both schemes where the token has a dark value, so dark doesn't drift from what was saved. */
export function applyTokenOverrides(css: string, overrides: Record<string, string>): { css: string; applied: string[]; skipped: string[] } {
  const known = new Map(parseTokens(css).flatMap((g) => g.tokens.map((t) => [t.name, t] as const)));
  let next = css;
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(overrides)) {
    const token = known.get(name);
    if (!token) {
      skipped.push(name);
      continue;
    }
    try {
      if (token.light !== "") next = setToken(next, name, "light", value);
      if (token.dark !== null) next = setToken(next, name, "dark", value);
      applied.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { css: next, applied, skipped };
}

/**
 * Save a system as the project's own, under `name`: a flat style stays flat, and a kit's copy keeps its components and
 * its `kitId`, so it's still a theme of that kit. `overrides` are token values to write into the copy.
 */
export function saveSystemCopy(system: DesignSystemInfo, projectPath: string, name: string, overrides: Record<string, string> = {}, folderName?: string): DesignSystemInfo {
  const clean = oneLine(name);
  const slug = folderName ?? systemSlug(clean);
  if (!clean || !slug) throw new Error("Give it a name with a letter or number in it.");
  const root = projectSystemsDir(projectPath);
  const folder = folderName ?? freeFolder(root, slug);
  const dest = join(root, folder);
  buildFolder(dest, (staging) => {
    const lines = ["---", `type: ${system.kit ? "design-kit" : "design-system"}`, `name: ${clean}`];
    if (system.description) lines.push(`description: ${oneLine(system.description)}`);
    if (system.swatches.length) lines.push(`swatches: ${system.swatches.join(", ")}`);
    lines.push("---", "", `Saved from ${system.name}. Rules in \`DESIGN.md\`, tokens in \`tokens.css\`.`, "");
    writeFileSync(join(staging, "index.md"), lines.join("\n"));
    copyFileSync(system.designMd, join(staging, "DESIGN.md"));
    if (system.tokensCss) {
      const css = readFileSync(system.tokensCss, "utf8");
      writeFileSync(join(staging, "tokens.css"), applyTokenOverrides(css, overrides).css);
    }
    if (system.fontFiles?.length) {
      mkdirSync(join(staging, "fonts"), { recursive: true });
      for (const file of system.fontFiles) copyFileSync(file, join(staging, "fonts", basename(file)));
    }
    if (!system.kit) return;
    for (const part of KIT_PARTS) {
      const src = join(system.kit.dir, part);
      if (!isFile(src)) continue;
      if (part === "components.json") writeFileSync(join(staging, part), ownManifest(readFileSync(src, "utf8")));
      else copyFileSync(src, join(staging, part));
    }
    const blocks = join(system.kit.dir, "blocks");
    if (existsSync(blocks)) cpSync(blocks, join(staging, "blocks"), { recursive: true });
  });
  const saved = listDesignSystems(projectPath).find((s) => s.id === `project:${folder}`);
  if (!saved) throw new Error("The copy didn't save correctly.");
  return saved;
}

/** The copy a first edit goes to, made once: a bundled or installed kit is never written in place. */
export function forkKitSystem(system: DesignSystemInfo, projectPath: string): DesignSystemInfo {
  const theme = system.id.includes("/") ? system.id.split("/").pop() : null;
  const folder = `${system.kit?.id ?? "kit"}${theme ? `-${theme}` : ""}-custom`;
  const existing = listDesignSystems(projectPath).find((s) => s.id === `project:${folder}`);
  return existing ?? saveSystemCopy(system, projectPath, `${system.name} (custom)`, {}, folder);
}

/** The files a draft in `{dir}/kit/` may send to the project. A board page or a stray note stays behind. */
const DRAFT_FILES = ["index.md", "DESIGN.md", "tokens.css", ...KIT_PARTS] as const;
const DRAFT_FOLDERS = ["blocks", "fonts"] as const;

/**
 * Start a draft in `{dir}/kit/`: a copy of `system`, the agent's only place to change a kit. With `identity` it becomes
 * a new kit of that name, otherwise a working copy of the same kit. An existing draft is kept, so later prompts refine it.
 */
export function seedKitDraft(system: DesignSystemInfo, draftDir: string, identity?: { kitId: string; name: string }): boolean {
  if (!system.kit) throw new Error("This design has no kit to start from.");
  if (isFile(join(draftDir, "components.json"))) return false;
  mkdirSync(draftDir, { recursive: true });
  copyFileSync(system.designMd, join(draftDir, "DESIGN.md"));
  if (system.tokensCss) copyFileSync(system.tokensCss, join(draftDir, "tokens.css"));
  for (const part of KIT_PARTS) {
    const src = join(system.kit.dir, part);
    if (!isFile(src)) continue;
    if (part !== "components.json") {
      copyFileSync(src, join(draftDir, part));
      continue;
    }
    writeFileSync(
      join(draftDir, part),
      ownManifest(readFileSync(src, "utf8"), (m) => {
        if (identity) Object.assign(m, { kitId: identity.kitId, name: identity.name, version: "0.1.0" });
      }),
    );
  }
  for (const folder of DRAFT_FOLDERS) {
    const src = folder === "blocks" ? join(system.kit.dir, "blocks") : null;
    if (src && existsSync(src)) cpSync(src, join(draftDir, folder), { recursive: true });
  }
  if (system.fontFiles?.length) {
    mkdirSync(join(draftDir, "fonts"), { recursive: true });
    for (const file of system.fontFiles) copyFileSync(file, join(draftDir, "fonts", basename(file)));
  }
  const name = identity?.name ?? system.name;
  writeFileSync(
    join(draftDir, "index.md"),
    ["---", "type: design-kit", `name: ${oneLine(name)}`, `description: ${oneLine(system.description || `A kit made from ${system.name}.`)}`, ...(system.swatches.length ? [`swatches: ${system.swatches.join(", ")}`] : []), "---", "", `Made in CubiQ from ${system.name}.`, ""].join("\n"),
  );
  return true;
}

/** What a draft changes against the kit it would replace. */
export interface KitDraftDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffManifests(before: KitManifest | null, after: KitManifest): KitDraftDiff {
  const old = new Map((before?.components ?? []).map((c) => [c.ui, c]));
  const fresh = new Map(after.components.map((c) => [c.ui, c]));
  const added = [...fresh.keys()].filter((ui) => !old.has(ui));
  const removed = [...old.keys()].filter((ui) => !fresh.has(ui));
  const changed = [...fresh.keys()].filter((ui) => old.has(ui) && JSON.stringify(old.get(ui)) !== JSON.stringify(fresh.get(ui)));
  return { added, removed, changed };
}

/** The manifest in a folder, or null when there's none or it doesn't parse. */
export function manifestIn(dir: string): KitManifest | null {
  try {
    const parsed = parseKitManifest(readFileSync(join(dir, "components.json"), "utf8"));
    return parsed.ok ? parsed.manifest : null;
  } catch {
    return null;
  }
}

export type KitSaveResult = { ok: true; folder: string; manifest: KitManifest; diff: KitDraftDiff } | { ok: false; errors: string[] };

/**
 * Validate a draft and copy it into the project: only the files a kit is made of, checked as they will land, then
 * renamed into place. `folder` is the folder it replaces or creates. `markNew` tags the parts this save adds, so Layers
 * and the badge can say so; an earlier tag stays until the kit is reviewed.
 */
export function saveKitDraft(draftDir: string, projectPath: string, folder: string, opts: { markNew?: boolean; base?: KitManifest | null } = {}): KitSaveResult {
  const root = projectSystemsDir(projectPath);
  const dest = join(root, folder);
  const previous = opts.base !== undefined ? opts.base : manifestIn(dest);
  let result: KitSaveResult = { ok: false, errors: ["The kit wasn't saved."] };
  const check = join(root, `.check-${folder}-${process.pid}`);
  mkdirSync(root, { recursive: true });
  rmSync(check, { recursive: true, force: true });
  mkdirSync(check, { recursive: true });
  try {
    for (const name of DRAFT_FILES) {
      const src = join(draftDir, name);
      if (isFile(src)) copyFileSync(src, join(check, name));
    }
    for (const name of DRAFT_FOLDERS) {
      const src = join(draftDir, name);
      if (existsSync(src)) cpSync(src, join(check, name), { recursive: true });
    }
    const verdict = validateKitDir(check);
    if (!verdict.ok) return { ok: false, errors: verdict.errors };
    const diff = diffManifests(previous, verdict.manifest);
    if (opts.markNew && diff.added.length) {
      const raw = JSON.parse(readFileSync(join(check, "components.json"), "utf8")) as { components: { ui: string; status?: string }[] };
      for (const c of raw.components) if (diff.added.includes(c.ui)) c.status = "new";
      writeFileSync(join(check, "components.json"), `${JSON.stringify(raw, null, 2)}\n`);
    }
    rmSync(dest, { recursive: true, force: true });
    renameSync(check, dest);
    result = { ok: true, folder, manifest: verdict.manifest, diff };
    return result;
  } finally {
    rmSync(check, { recursive: true, force: true });
  }
}

type Node5 = DefaultTreeAdapterMap["node"];
type El5 = DefaultTreeAdapterMap["element"];
const isEl = (n: Node5): n is El5 => "attrs" in n;
const kids = (n: Node5): Node5[] => ("childNodes" in n ? n.childNodes : []);
const walk = (n: Node5): El5[] => kids(n).filter(isEl).flatMap((e) => [e, ...walk(e)]);

/** What won't carry over when `html` becomes a block: its styling that isn't the kit's. */
export function compositionWarnings(html: string): string[] {
  const els = walk(parseFragment(html));
  const styled = els.filter((e) => e.attrs.some((a) => a.name === "style" && a.value.trim())).length;
  const classed = els.filter((e) => e.attrs.some((a) => a.name === "class" && a.value.trim())).length;
  const out: string[] = [];
  if (styled) out.push(`${styled === 1 ? "1 element has" : `${styled} elements have`} its own inline styles, kept as they are, so they won't follow a theme.`);
  if (classed) out.push(`${classed === 1 ? "1 element uses" : `${classed} elements use`} classes from this page, which the kit doesn't have.`);
  if (els.some((e) => e.tagName === "style")) out.push("A <style> block on the page won't come along.");
  return out;
}

/** The HTML with the editor's ids off and no script or handler, ready to keep in a kit. */
export function cleanCompositionHtml(html: string): string {
  const holder = parseFragment(html);
  for (const el of walk(holder)) el.attrs = el.attrs.filter((a) => a.name !== "data-agent-id" && !/^on/i.test(a.name));
  const drop = (n: Node5): void => {
    if ("childNodes" in n) {
      n.childNodes = n.childNodes.filter((c) => !(isEl(c) && c.tagName === "script"));
      n.childNodes.forEach(drop);
    }
  };
  drop(holder);
  return serialize(holder).trim();
}

/** Keep a selection as a reusable block of the kit in `kitDir`: `blocks/<ui>.html` and one manifest entry. Returns its `data-ui`. */
export function addComposition(kitDir: string, name: string, html: string): { ui: string } {
  const clean = oneLine(name);
  const base = systemSlug(clean);
  if (!clean || !base) throw new Error("Give it a name with a letter or number in it.");
  const path = join(kitDir, "components.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { components: { ui: string; name: string }[] };
  if (manifest.components.some((c) => c.name.toLowerCase() === clean.toLowerCase())) throw new Error(`The kit already has a ${clean}.`);
  const taken = new Set(manifest.components.map((c) => c.ui));
  let ui = base;
  for (let n = 2; taken.has(ui); n++) ui = `${base}-${n}`;
  const body = cleanCompositionHtml(html);
  const remote = findRemoteUrls(body);
  if (remote.length) throw new Error(`It links to ${remote[0]}, and the canvas has no network.`);
  const snippet = `<div data-ui="${ui}">${body}</div>`;
  if (snippet.length > 4096) throw new Error("That's too large to keep as a composition (over 4 KB of HTML).");
  manifest.components.push({ name: clean, ui, kind: "composition", category: "Compositions", props: [], snippet } as unknown as { ui: string; name: string });
  mkdirSync(join(kitDir, "blocks"), { recursive: true });
  writeFileSync(join(kitDir, "blocks", `${ui}.html`), `${snippet}\n`);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ui };
}

/** How many times each `data-ui` value appears in a page's text. */
export function partCounts(html: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/\bdata-ui\s*=\s*["']?([a-z0-9-]+)/g)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  return counts;
}

/** The parts whose CSS uses a token: every `data-ui` named in a rule that reads `var(--token)`. */
export function partsUsingToken(uiCss: string, token: string): Set<string> {
  const out = new Set<string>();
  const needle = `var(${token}`;
  let start = 0;
  for (const m of uiCss.matchAll(/[{}]/g)) {
    const at = m.index;
    if (m[0] === "}") {
      start = at + 1;
      continue;
    }
    const close = uiCss.indexOf("}", at);
    if (close === -1) break;
    if (uiCss.slice(at, close).includes(needle)) {
      for (const ui of uiCss.slice(start, at).matchAll(/data-ui\s*[~|^$*]?=\s*["']?([a-z0-9-]+)/g)) out.add(ui[1]!);
    }
    start = at + 1;
  }
  return out;
}

/** A readable ink on `hex`: white or black, whichever contrasts more. */
function inkOn(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const channel = (at: number): number => {
    const s = parseInt(m[1]!.slice(at, at + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#ffffff" : "#000000";
}

/**
 * The tokens a brand colour rewrites in a tokens.css: its fill and focus roles, and the text on it. A kit's tints
 * (`--color-primary-hover`, `-soft`…) are derived with `color-mix`, so they keep following it in either scheme.
 */
export function brandEdits(css: string, hex: string): { name: string; light: string; dark: string | null }[] {
  const tokens = parseTokens(css).flatMap((g) => g.tokens);
  const out: { name: string; light: string; dark: string | null }[] = [];
  const tints: Record<string, string> = {
    "--color-primary-hover": `color-mix(in srgb, ${hex} 86%, white)`,
    "--color-primary-active": `color-mix(in srgb, ${hex} 84%, black)`,
    "--color-primary-light": `color-mix(in srgb, ${hex} 70%, white)`,
    "--color-primary-dark": `color-mix(in srgb, ${hex} 80%, black)`,
    "--color-primary-fill": hex,
    "--color-primary-text": hex,
    "--color-primary-border": `color-mix(in srgb, ${hex} 45%, white)`,
    "--color-primary-border-hover": `color-mix(in srgb, ${hex} 65%, white)`,
    "--color-primary-bg": `color-mix(in srgb, ${hex} 10%, transparent)`,
    "--color-primary-bg-hover": `color-mix(in srgb, ${hex} 18%, transparent)`,
    "--color-primary-soft": `color-mix(in srgb, ${hex} 12%, transparent)`,
    "--color-accent": hex,
    "--color-accent-soft": `color-mix(in srgb, ${hex} 12%, transparent)`,
    "--color-accent-text": hex,
    "--color-focus": hex,
    "--color-primary": hex,
    "--color-on-primary": inkOn(hex),
    "--color-on-primary-fill": inkOn(hex),
  };
  for (const t of tokens) {
    const value = tints[t.name];
    if (value) out.push({ name: t.name, light: value, dark: t.dark === null ? null : value });
  }
  return out;
}

/** A part's first element with these props set: the snippet is a demo, often several in a row. */
const CONTROL_TAGS = new Set(["button", "a", "input", "select", "textarea"]);
const FIELD_TAGS = new Set(["input", "select", "textarea"]);
const CONTROL_ROLES = new Set(["button", "checkbox", "radio", "switch", "tab", "slider", "option", "menuitem", "combobox", "textbox"]);
const isControl = (e: El5): boolean => CONTROL_TAGS.has(e.tagName) || CONTROL_ROLES.has(e.attrs.find((a) => a.name === "role")?.value ?? "");
const firstInstance = (snippet: string, ui: string): El5 | undefined => walk(parseFragment(snippet)).find((e) => e.attrs.some((a) => a.name === "data-ui" && a.value === ui));

/**
 * Whether a part is a control whose states are worth a matrix (Normal, Hover, Focus, Disabled): it is one, or it's a
 * small wrapper around one (a text field). Layouts, cards, tables and overlays get a gallery instead.
 */
export function isStatefulPart(part: { ui: string; snippet: string }): boolean {
  const root = firstInstance(part.snippet, part.ui);
  if (!root || root.tagName === "dialog" || root.attrs.some((a) => a.name === "popover")) return false;
  if (isControl(root)) return true;
  // A small wrapper around one form field (a text field, a labelled checkbox), not a card or a bar that holds buttons.
  const inside = walk(root);
  return inside.length <= 6 && inside.filter((e) => FIELD_TAGS.has(e.tagName)).length === 1;
}

function instanceHtml(snippet: string, ui: string, props: Record<string, string>, extra: Record<string, string> = {}): string {
  const found = firstInstance(snippet, ui);
  if (!found) return snippet;
  for (const [name, value] of Object.entries(props)) {
    const key = `data-${name}`;
    found.attrs = found.attrs.filter((a) => a.name !== key);
    if (value !== "false" && value !== "") found.attrs.push({ name: key, value: value === "true" ? "" : value });
  }
  for (const [name, value] of Object.entries(extra)) {
    // `disabled` reaches the controls inside a wrapper too, so a text field's input greys out with it.
    for (const el of name === "disabled" ? [found, ...walk(found).filter(isControl)] : [found]) {
      el.attrs = el.attrs.filter((a) => a.name !== name);
      el.attrs.push({ name, value });
    }
  }
  const holder = parseFragment("");
  holder.childNodes = [found];
  return serialize(holder);
}

const escapeText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A page showing one part, linked to the kit in `folder`: a variant × state matrix (controls), a gallery of its variants
 * at full width, or one instance with the given props. Its own scaffold is inline; only the kit's styles draw the part.
 */
export function partSample(part: { ui: string; snippet: string; props: { name: string; options?: string[] | undefined; default?: string | boolean | undefined }[] }, folder: string, request: KitSampleRequest, uiCss = ""): string {
  const variantProp = part.props.find((p) => p.name === "variant");
  const variants = variantProp?.options ?? [];
  const sizes = part.props.find((p) => p.name === "size")?.options ?? [];
  let body: string;
  let forced = "";
  if (request.states) {
    // Rows are variants, columns are states: hover and focus are forced with copies of the kit's own rules.
    const rows = (request.variants?.length ? variants.filter((v) => request.variants!.includes(v)) : variants).slice(0, 12);
    const size: Record<string, string> = request.size && sizes.includes(request.size) ? { size: request.size } : {};
    const states: { label: string; extra: Record<string, string> }[] = [
      { label: "Normal", extra: {} },
      { label: "Hover", extra: { "data-cq-hover": "" } },
      { label: "Focus", extra: { "data-cq-focus": "" } },
      { label: "Disabled", extra: { disabled: "", "data-disabled": "", "aria-disabled": "true" } },
    ];
    const head = `<tr><th></th>${states.map((s) => `<th>${s.label}</th>`).join("")}</tr>`;
    const lines = (rows.length ? rows : [""]).map((variant) => {
      const props: Record<string, string> = { ...(request.props ?? {}), ...(variant ? { variant } : {}), ...size };
      const label = variant ? `${escapeText(variant)}${variant === variantProp?.default ? ' <span class="cq-tag">default</span>' : ""}` : escapeText(part.ui);
      return `<tr><th class="cq-label">${label}</th>${states.map((s) => `<td>${instanceHtml(part.snippet, part.ui, props, s.extra)}</td>`).join("")}</tr>`;
    });
    body = `<div class="cq-stage cq-flush"><table class="cq-matrix"><thead>${head}</thead><tbody>${lines.join("")}</tbody></table></div>`;
    forced = forcedStateCss(uiCss, folder);
  } else if (request.matrix) {
    // A gallery: each picked variant at full width, or the kit's own demo when the part has none.
    const rows = variants.length ? (request.variants?.length ? variants.filter((v) => request.variants!.includes(v)) : variants) : [];
    const size: Record<string, string> = request.size && sizes.includes(request.size) ? { size: request.size } : {};
    body = rows.length
      ? rows
          .map((variant) => {
            const label = `${escapeText(variant)}${variant === variantProp?.default ? ' <span class="cq-tag">default</span>' : ""}`;
            return `<section class="cq-section"><h3 class="cq-label">${label}</h3><div class="cq-stage">${instanceHtml(part.snippet, part.ui, { ...(request.props ?? {}), variant, ...size })}</div></section>`;
          })
          .join("")
      : `<section class="cq-section"><div class="cq-stage cq-demo">${part.snippet}</div></section>`;
  } else if (request.props && Object.keys(request.props).length) {
    body = `<section class="cq-section"><div class="cq-stage cq-demo">${instanceHtml(part.snippet, part.ui, request.props)}</div></section>`;
  } else {
    body = `<section class="cq-section"><div class="cq-stage cq-demo">${part.snippet}</div></section>`;
  }
  // Overlays open in place, so a dialog or menu shows rather than its trigger alone.
  body = body.replace(/<dialog\b(?![^>]*\sopen\b)/g, "<dialog open");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${folder}/tokens.css">${forced ? "" : `<link rel="stylesheet" href="${folder}/ui.css">`}
<style>
html,body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-sans,system-ui)}
body{padding:24px 28px 8px;box-sizing:border-box}
.cq-section{display:grid;gap:10px;margin:0 0 28px}
.cq-label{display:flex;align-items:center;gap:8px;margin:0;font:600 13px/18px system-ui;color:var(--color-text)}
.cq-label::first-letter{text-transform:uppercase}
.cq-tag{padding:1px 7px;border:1px solid var(--color-border);border-radius:999px;font:400 11px/15px system-ui;color:var(--color-text-muted)}
.cq-stage{position:relative;transform:translateZ(0);display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:16px;min-width:0;min-height:180px;padding:40px;box-sizing:border-box;border:1px solid var(--color-border);border-radius:12px}
.cq-stage>*{max-width:100%}
.cq-demo{min-height:320px}
.cq-stage:has([popover]){align-items:flex-start;min-height:360px}
.cq-flush{display:block;min-height:0;padding:8px 24px}
.cq-stage dialog[open]{position:static;inset:auto;margin:0;transform:none;max-width:100%}
.cq-stage dialog[open]::backdrop{display:none}
.cq-matrix{width:100%;table-layout:fixed;border-collapse:collapse}
.cq-matrix th,.cq-matrix td{padding:20px 12px;text-align:center;vertical-align:middle;overflow:hidden}
.cq-matrix tbody tr{border-top:1px solid var(--color-border)}
.cq-matrix td>*{margin-inline:auto;max-width:100%}
.cq-matrix tr>:first-child{width:128px;padding-left:0;text-align:left}
.cq-matrix thead th{padding:14px 12px 10px;font:500 12px/16px system-ui;color:var(--color-text-muted)}
.cq-matrix .cq-label{display:table-cell;font-weight:500;white-space:nowrap;text-overflow:ellipsis}
.cq-matrix .cq-tag{margin-left:6px}
</style>${forced ? `<style>${forced.replace(/<\/style/gi, "<\\/style")}</style>` : ""}</head><body>${body}<script src="${folder}/ui.js"></script><script>for(const p of document.querySelectorAll(".cq-stage [popover]"))try{p.showPopover()}catch{}</script></body></html>
`;
}

/** What System mode asks a part's sample for, less the part. */
export type KitSampleRequest = Omit<DesignKitSampleRequest, "ui">;

/**
 * A kit's ui.css with every hover and focus state also matching `[data-cq-hover]` / `[data-cq-focus]`, so a sample can show
 * those states without a pointer. Nesting and media queries stay as they are; relative urls are rebased onto `folder`.
 */
export function forcedStateCss(css: string, folder: string): string {
  return css
    .replace(/:hover(?![\w-])/g, ":is(:hover, [data-cq-hover])")
    .replace(/:focus-visible(?![\w-])/g, ":is(:focus-visible, [data-cq-focus])")
    .replace(/:focus(?![\w-])/g, ":is(:focus, [data-cq-focus])")
    .replace(/:focus-within(?![\w-])/g, ":is(:focus-within, [data-cq-focus])")
    .replace(/url\(\s*(["']?)(?![a-z][\w+.-]*:|\/|#)([^"')]+)\1\s*\)/gi, (_m, q: string, path: string) => `url(${q}${folder}/${path}${q})`);
}

/** One manifest edit from System mode. Anything needing new markup goes to the agent instead. */
export type KitManifestEdit =
  | { kind: "addVariant"; ui: string; name: string; from: string }
  | { kind: "removeVariant"; ui: string; name: string }
  | { kind: "addProp"; ui: string; prop: { name: string; label: string; type: "text" | "boolean" | "choice"; options?: string[]; default?: string | boolean } }
  | { kind: "removeProp"; ui: string; name: string }
  | { kind: "removeComponent"; ui: string }
  | { kind: "markReviewed"; ui: string };

interface RawProp {
  name: string;
  label?: string;
  type: string;
  options?: string[];
  default?: string | boolean;
}
interface RawPart {
  ui: string;
  name: string;
  props?: RawProp[];
  status?: string;
}

/**
 * Copy `from`'s rules for a part's variant under a new variant name, at the end of the sheet. Rules are found at any depth
 * (inside `@layer`, `@media` or a nested part rule) and copied inside the same chain of outer blocks, so they keep their
 * layer, query and part.
 */
function copyVariantRules(css: string, ui: string, from: string, to: string): { css: string; copied: number } {
  const blocks: string[] = [];
  const name = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const variant = new RegExp(`\\[data-variant=["']?${name}["']?\\]`);
  const variantAll = new RegExp(variant.source, "g");
  const part = new RegExp(`data-ui=["']?${ui}["'\\]]`);
  const visit = (from: number, to_: number, chain: string[]): void => {
    let start = from;
    for (let i = from; i < to_; i++) {
      const ch = css[i];
      if (ch === "{") {
        const close = matchBrace(css, i);
        if (close === -1 || close > to_) return;
        const prelude = css.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, "").trim();
        if (variant.test(prelude) && (part.test(prelude) || chain.some((p) => part.test(p)))) {
          let block = `${prelude.replace(variantAll, `[data-variant="${to}"]`)} ${css.slice(i, close + 1)}`;
          for (const outer of [...chain].reverse()) block = `${outer} { ${block} }`;
          blocks.push(block);
        } else {
          visit(i + 1, close, [...chain, prelude]);
        }
        i = close;
        start = close + 1;
      } else if (ch === "}" || ch === ";") {
        start = i + 1;
      }
    }
  };
  visit(0, css.length, []);
  if (!blocks.length) return { css, copied: 0 };
  return { css: `${css.trimEnd()}\n\n/* Variant ${to} of ${ui}, copied from ${from}. */\n${blocks.join("\n")}\n`, copied: blocks.length };
}

function matchBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Apply one System mode edit to a kit folder. It changes the `components.json` contract, and for a variant also copies
 * its CSS rules, so the new variant renders as soon as it's picked. Throws with a message the panel can show.
 */
export function applyKitEdit(kitDir: string, edit: KitManifestEdit): void {
  const path = join(kitDir, "components.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { components: RawPart[] };
  const part = manifest.components.find((c) => c.ui === edit.ui);
  if (!part) throw new Error("That component isn't in the kit.");
  const variantProp = (part.props ?? []).find((p) => p.name === "variant");
  switch (edit.kind) {
    case "addVariant": {
      const name = systemSlug(edit.name);
      if (!name) throw new Error("Give the variant a name with a letter or number in it.");
      if (!variantProp?.options) throw new Error(`${part.name} has no variants to copy from.`);
      if (variantProp.options.includes(name)) throw new Error(`${part.name} already has ${name}.`);
      const cssPath = join(kitDir, "ui.css");
      const copied = copyVariantRules(readFileSync(cssPath, "utf8"), part.ui, edit.from, name);
      if (!copied.copied) throw new Error(`${edit.from} has no rules of its own to copy. Ask the agent for this variant.`);
      writeFileSync(cssPath, copied.css);
      variantProp.options.push(name);
      break;
    }
    case "removeVariant": {
      if (!variantProp?.options) throw new Error(`${part.name} has no variants.`);
      if (variantProp.options.length < 2) throw new Error("A component needs at least one variant.");
      variantProp.options = variantProp.options.filter((o) => o !== edit.name);
      if (variantProp.default === edit.name) variantProp.default = variantProp.options[0]!;
      break;
    }
    case "addProp": {
      const name = systemSlug(edit.prop.name);
      if (!name || name === "ui") throw new Error("That prop name can't be used.");
      part.props = part.props ?? [];
      if (part.props.some((p) => p.name === name)) throw new Error(`${part.name} already has ${name}.`);
      part.props.push({ ...edit.prop, name, label: oneLine(edit.prop.label) || name });
      break;
    }
    case "removeProp":
      part.props = (part.props ?? []).filter((p) => p.name !== edit.name);
      break;
    case "removeComponent":
      if (manifest.components.length < 2) throw new Error("A kit needs at least one component.");
      manifest.components = manifest.components.filter((c) => c.ui !== edit.ui);
      break;
    case "markReviewed":
      delete part.status;
      break;
  }
  const text = JSON.stringify(manifest, null, 2);
  const parsed = parseKitManifest(text);
  if (!parsed.ok) throw new Error(parsed.errors[0] ?? "That edit would break the kit.");
  writeFileSync(path, `${text}\n`);
}

/** Every folder name in a project's design systems that holds the kit `kitId`. */
export function projectKitFolders(projectPath: string, kitId: string): string[] {
  try {
    return readdirSync(projectSystemsDir(projectPath), { withFileTypes: true })
      .filter((e) => e.isDirectory() && manifestIn(join(projectSystemsDir(projectPath), e.name))?.kitId === kitId)
      .map((e) => e.name);
  } catch {
    return [];
  }
}
