// A Creator app: a folder of plain HTML/CSS/JS with an app.json, run in a sandboxed frame. No build step, no npm:
// what the agent writes is what runs. The manifest declares the connector tools the app may call (its grants);
// nothing else leaves the frame.

import { extname } from "node:path";
import { validateRelativeFilePath } from "../extensions/manifest";

export const APP_MANIFEST = "app.json";
export const APP_MAX_FILES = 64;
export const APP_MAX_FILE_BYTES = 512 * 1024;
export const APP_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
/** Text files only: a proposal carries file contents as strings, and drawings are SVG. */
export const APP_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg", ".md", ".txt"]);

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** An MCP server name, as `src/main/mcp/servers.ts` accepts it. */
const SERVER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const TOOL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const ICON_RE = /^[a-z0-9-]{1,40}$/;
const MAX_GRANT_SERVERS = 8;
const MAX_GRANT_TOOLS = 32;

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
  const known = new Set(["name", "title", "description", "icon", "entry", "grants", "cacheSec"]);
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
  return { ok: true, manifest, files: out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

/** Whether `tool` on `server` is one of the app's grants. */
export function granted(manifest: AppManifest, server: string, tool: string): boolean {
  return manifest.grants.some((g) => g.server === server && g.tools.includes(tool));
}
