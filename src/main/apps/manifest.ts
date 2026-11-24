// A Creator app: a folder of plain HTML/CSS/JS with an app.json, run in a sandboxed frame. No build step, no npm:
// what the agent writes is what runs. The manifest declares the connector tools the app may call (its grants);
// nothing else leaves the frame.

import { extname } from "node:path";
import { validateRelativeFilePath } from "../extensions/manifest";
import type { PluginCard, PluginTool } from "../../shared/plugin-tools";
import { parsePluginInput } from "./tool-schema";
import type { PluginContributions } from "../../shared/plugin-parts";
import { parseContributions } from "./parts";
import { validateProposal } from "../extensions/manifest";

export const APP_MANIFEST = "app.json";
export const APP_MAX_FILES = 64;
export const APP_MAX_FILE_BYTES = 512 * 1024;
export const APP_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
/** Text files only: a proposal carries file contents as strings, and drawings are SVG. */
export const APP_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg", ".md", ".txt", ".yaml", ".yml", ".csv"]);

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** An MCP server name, as `src/main/mcp/servers.ts` accepts it. */
const SERVER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const TOOL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const ICON_RE = /^[a-z0-9-]{1,40}$/;
const MAX_GRANT_SERVERS = 8;
const MAX_GRANT_TOOLS = 32;
/** A floating widget's size bounds and default, in CSS px. */
export const FLOATING_MIN = { width: 160, height: 80 } as const;
export const FLOATING_MAX = { width: 480, height: 600 } as const;
export const FLOATING_DEFAULT = { width: 280, height: 200 } as const;
/** The size a modal app is checked at (the modal's largest size). */
export const MODAL_SIZE = { width: 900, height: 700 } as const;
/** A composer dock's and a sidebar panel's frame height bounds and default (their width is the host's). */
export const DOCK_HEIGHT = { min: 32, max: 160, default: 48 } as const;
export const PANEL_HEIGHT = { min: 80, max: 320, default: 160 } as const;
/** The width a dock and a panel are checked at (a typical composer and sidebar). */
export const DOCK_CHECK_WIDTH = 680;
export const PANEL_CHECK_WIDTH = 232;

export const APP_PLACEMENTS = ["modal", "floating", "page", "dock", "panel"] as const;
export type AppPlacement = (typeof APP_PLACEMENTS)[number];

export interface AppGrant {
  server: string;
  tools: string[];
}

export interface AppManifest {
  name: string;
  title: string;
  description: string;
  /** A lucide icon name; the sidebar falls back to a generic one. */
  icon?: string;
  /** The page the frame opens, relative to the app folder. */
  entry: string;
  /** Connector tools the app may call through the bridge, per server. */
  grants: AppGrant[];
  /** How long an identical call's result is reused, in seconds (default 0: every call goes out). */
  cacheSec?: number;
  /**
   * Where it shows: a centred modal (default), a small floating widget over the app, a full page in the main area,
   * a strip docked above the composer, or a panel in the left sidebar.
   */
  placement?: AppPlacement;
  /** A floating widget's size (default 280×200). */
  size?: { width: number; height: number };
  /** A dock's or a panel's frame height (defaults 48 and 160). */
  height?: number;
  /** "own": no CubiQ base sheet (font, background) and a transparent frame; the theme variables still arrive. */
  style?: "cubiq" | "own";
  /** Agent-callable handlers in a fresh hidden frame; never run at startup. */
  tools?: PluginTool[];
  toolEntry?: string;
  cards?: PluginCard[];
  contributes?: PluginContributions;
}

export interface AppFile {
  path: string;
  content: string;
}

export type AppCheck = { ok: true; manifest: AppManifest; files: AppFile[] } | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse and check app.json; `paths` are the app's files, so `entry` must be one of them. */
export function parseAppManifest(text: string, paths: ReadonlySet<string>, expectedName?: string): { manifest: AppManifest | null; errors: string[] } {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { manifest: null, errors: [`app.json is not valid JSON: ${(e as Error).message}`] };
  }
  if (!isRecord(raw)) return { manifest: null, errors: ["app.json must be a JSON object."] };
  const known = new Set(["name", "title", "description", "icon", "entry", "grants", "cacheSec", "placement", "size", "height", "style", "tools", "toolEntry", "cards", "contributes"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) errors.push(`Unknown app.json field "${k}". Fields: ${[...known].join(", ")}.`);

  const name = raw.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) errors.push('app.json "name" must be lowercase letters, digits and "-" (up to 64), starting with a letter or digit.');
  else if (expectedName !== undefined && name !== expectedName) errors.push(`app.json "name" is "${name}" but the app is named "${expectedName}".`);
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title || title.length > 60) errors.push('app.json "title" must be 1-60 characters.');
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description || description.length > 300) errors.push('app.json "description" must be 1-300 characters.');
  if (raw.icon !== undefined && (typeof raw.icon !== "string" || !ICON_RE.test(raw.icon))) errors.push('app.json "icon" must be a lucide icon name such as "chart-bar".');
  const entry = raw.entry ?? "index.html";
  if (typeof entry !== "string" || extname(entry).toLowerCase() !== ".html" || !paths.has(entry)) errors.push(`app.json "entry" must name one of the app's .html files (got ${JSON.stringify(entry)}).`);
  if (raw.cacheSec !== undefined && (typeof raw.cacheSec !== "number" || !Number.isInteger(raw.cacheSec) || raw.cacheSec < 0 || raw.cacheSec > 3600)) {
    errors.push('app.json "cacheSec" must be a whole number of seconds from 0 to 3600.');
  }

  if (raw.placement !== undefined && !(APP_PLACEMENTS as readonly unknown[]).includes(raw.placement)) errors.push(`app.json "placement" must be one of ${APP_PLACEMENTS.map((p) => `"${p}"`).join(", ")}.`);
  if (raw.style !== undefined && raw.style !== "cubiq" && raw.style !== "own") errors.push('app.json "style" must be "cubiq" or "own".');
  let size: { width: number; height: number } | undefined;
  if (raw.size !== undefined) {
    const sz = raw.size;
    const ok = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
    if (raw.placement !== "floating") errors.push('app.json "size" only applies to "placement": "floating".');
    else if (!isRecord(sz) || Object.keys(sz).some((k) => k !== "width" && k !== "height") || !ok(sz.width, FLOATING_MIN.width, FLOATING_MAX.width) || !ok(sz.height, FLOATING_MIN.height, FLOATING_MAX.height)) {
      errors.push(`app.json "size" is { "width": ${FLOATING_MIN.width}-${FLOATING_MAX.width}, "height": ${FLOATING_MIN.height}-${FLOATING_MAX.height} } in whole pixels.`);
    } else size = { width: sz.width, height: sz.height };
  }

  let height: number | undefined;
  if (raw.height !== undefined) {
    const bounds = raw.placement === "dock" ? DOCK_HEIGHT : raw.placement === "panel" ? PANEL_HEIGHT : null;
    if (!bounds) errors.push('app.json "height" only applies to "placement": "dock" or "panel" (a floating widget uses "size").');
    else if (typeof raw.height !== "number" || !Number.isInteger(raw.height) || raw.height < bounds.min || raw.height > bounds.max) {
      errors.push(`app.json "height" for a ${raw.placement} is a whole number of pixels from ${bounds.min} to ${bounds.max}.`);
    } else height = raw.height;
  }

  const grants: AppGrant[] = [];
  if (raw.grants !== undefined && !Array.isArray(raw.grants)) errors.push('app.json "grants" must be a list of { "server", "tools" }.');
  const seen = new Set<string>();
  for (const g of Array.isArray(raw.grants) ? raw.grants : []) {
    if (!isRecord(g) || typeof g.server !== "string" || !SERVER_RE.test(g.server) || !Array.isArray(g.tools)) {
      errors.push('Each grant is { "server": "<connector name>", "tools": ["<tool>", ...] }.');
      continue;
    }
    if (seen.has(g.server)) {
      errors.push(`Grant for "${g.server}" is listed twice; merge its tools.`);
      continue;
    }
    seen.add(g.server);
    const tools = [...new Set(g.tools)];
    if (!tools.length || tools.length > MAX_GRANT_TOOLS || !tools.every((t): t is string => typeof t === "string" && TOOL_RE.test(t))) {
      errors.push(`Grant "${g.server}" needs 1-${MAX_GRANT_TOOLS} tool names (no wildcards).`);
      continue;
    }
    grants.push({ server: g.server, tools: tools.sort() });
  }
  if (grants.length > MAX_GRANT_SERVERS) errors.push(`An app may use at most ${MAX_GRANT_SERVERS} connectors.`);

  const localHtml = (v: unknown): v is string => typeof v === "string" && extname(v).toLowerCase() === ".html" && paths.has(v);
  const partName = /^[a-z][a-z0-9_]{0,31}$/;
  const tools: PluginTool[] = [];
  if (raw.tools !== undefined && (!Array.isArray(raw.tools) || raw.tools.length > 16)) errors.push('app.json "tools" is a list of at most 16 tools.');
  for (const t of Array.isArray(raw.tools) ? raw.tools.slice(0, 16) : []) {
    try {
      if (!isRecord(t) || Object.keys(t).some((k) => !["name", "description", "inputSchema"].includes(k)) || typeof t.name !== "string" || !partName.test(t.name) || tools.some((x) => x.name === t.name)) throw new Error("Each tool needs a unique name (lowercase letters, digits, underscores; max 32).");
      if (typeof t.description !== "string" || !t.description.trim() || t.description.length > 500) throw new Error("Each tool needs a description of 1-500 characters.");
      tools.push({ name: t.name, description: t.description.trim(), inputSchema: parsePluginInput(t.inputSchema) });
    } catch (e) { errors.push(`app.json tools: ${(e as Error).message}`); }
  }
  if (raw.toolEntry !== undefined && (!tools.length || !localHtml(raw.toolEntry))) errors.push('app.json "toolEntry" needs tools and must name a local .html file.');
  const cards: PluginCard[] = [];
  if (raw.cards !== undefined && (!Array.isArray(raw.cards) || raw.cards.length > 8)) errors.push('app.json "cards" is a list of at most 8 cards.');
  for (const c of Array.isArray(raw.cards) ? raw.cards.slice(0, 8) : []) {
    if (!isRecord(c) || Object.keys(c).some((k) => !["name", "entry", "height"].includes(k)) || typeof c.name !== "string" || !partName.test(c.name) || cards.some((x) => x.name === c.name) || !localHtml(c.entry) || (c.height !== undefined && (typeof c.height !== "number" || !Number.isInteger(c.height) || c.height < 80 || c.height > 600))) {
      errors.push("Each card needs a unique name, a local HTML entry and optional height (80-600 pixels).");
    } else cards.push({ name: c.name, entry: c.entry, height: typeof c.height === "number" ? c.height : 200 });
  }

  let contributes: PluginContributions | undefined;
  try { contributes = parseContributions(raw.contributes, paths); }
  catch (e) { errors.push(`app.json contributes: ${(e as Error).message}`); }
  if (errors.length) return { manifest: null, errors };
  return {
    manifest: {
      name: name as string,
      title,
      description,
      ...(typeof raw.icon === "string" ? { icon: raw.icon } : {}),
      entry: entry as string,
      grants: grants.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0)),
      ...(typeof raw.cacheSec === "number" && raw.cacheSec > 0 ? { cacheSec: raw.cacheSec } : {}),
      // Defaults are left out, so an app written before these fields reads exactly as it did.
      ...(raw.placement === "floating" ? { placement: "floating" as const, size: size ?? { ...FLOATING_DEFAULT } } : {}),
      ...(raw.placement === "page" ? { placement: "page" as const } : {}),
      ...(raw.placement === "dock" ? { placement: "dock" as const, height: height ?? DOCK_HEIGHT.default } : {}),
      ...(raw.placement === "panel" ? { placement: "panel" as const, height: height ?? PANEL_HEIGHT.default } : {}),
      ...(raw.style === "own" ? { style: "own" as const } : {}),
      ...(tools.length ? { tools, ...(typeof raw.toolEntry === "string" ? { toolEntry: raw.toolEntry } : {}) } : {}),
      ...(cards.length ? { cards } : {}),
      ...(contributes ? { contributes } : {}),
    },
    errors,
  };
}

/** Check an app's files and manifest together; returns them sorted by path, or model-readable errors. */
export function validateApp(name: string, files: unknown): AppCheck {
  const errors: string[] = [];
  if (!Array.isArray(files) || !files.length) return { ok: false, errors: ["An app needs files, including app.json and its entry page."] };
  if (files.length > APP_MAX_FILES) errors.push(`An app may have at most ${APP_MAX_FILES} files.`);
  const out: AppFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (!isRecord(f) || typeof f.content !== "string") {
      errors.push('Each file is { "path", "content" } with text content.');
      continue;
    }
    const path = validateRelativeFilePath(f.path, APP_ALLOWED_EXTENSIONS, "app", errors);
    if (!path) continue;
    const key = process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
    if (seen.has(key)) {
      errors.push(`File "${path}" is listed twice.`);
      continue;
    }
    seen.add(key);
    const bytes = Buffer.byteLength(f.content, "utf-8");
    if (bytes > APP_MAX_FILE_BYTES) errors.push(`File "${path}" is ${bytes} bytes; the limit is ${APP_MAX_FILE_BYTES}.`);
    total += bytes;
    out.push({ path, content: f.content });
  }
  if (total > APP_MAX_TOTAL_BYTES) errors.push(`The app is ${total} bytes; the limit is ${APP_MAX_TOTAL_BYTES}.`);
  const manifestFile = out.find((f) => f.path === APP_MANIFEST);
  if (!manifestFile) errors.push("An app needs an app.json at its top level.");
  if (errors.length || !manifestFile) return { ok: false, errors };
  const { manifest, errors: mErrors } = parseAppManifest(manifestFile.content, new Set(out.map((f) => f.path)), name);
  if (!manifest) return { ok: false, errors: mErrors };
  for (const skill of manifest.contributes?.skills ?? []) {
    const files = out.filter((f) => f.path.startsWith(`${skill.path}/`)).map((f) => ({ path: f.path.slice(skill.path.length + 1), content: f.content }));
    const check = validateProposal({ kind: "skill", name: skill.name, description: skill.description, files }, { scope: { kind: "global" } });
    if (!check.ok) errors.push(...check.errors.map((e) => `${skill.name}: ${e}`));
    else if (check.proposal.draft.kind === "skill") for (const f of check.proposal.draft.files) out.find((o) => o.path === `${skill.path}/${f.path}`)!.content = f.content;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest, files: out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

/** Whether `tool` on `server` is one of the app's grants. */
export function granted(manifest: AppManifest, server: string, tool: string): boolean {
  return manifest.grants.some((g) => g.server === server && g.tools.includes(tool));
}

/** The size an app shows at: a floating widget's own, a dock's or panel's height at a typical width, else the modal's. */
export function appSize(manifest: Pick<AppManifest, "placement" | "size" | "height">): { width: number; height: number } {
  switch (manifest.placement) {
    case "floating":
      return manifest.size ?? { ...FLOATING_DEFAULT };
    case "dock":
      return { width: DOCK_CHECK_WIDTH, height: manifest.height ?? DOCK_HEIGHT.default };
    case "panel":
      return { width: PANEL_CHECK_WIDTH, height: manifest.height ?? PANEL_HEIGHT.default };
    default:
      return { ...MODAL_SIZE };
  }
}

/** Small surfaces (widget, dock, panel) may show very little text and still be fine. */
export const isSmallPlacement = (p: AppPlacement | undefined): boolean => p === "floating" || p === "dock" || p === "panel";
