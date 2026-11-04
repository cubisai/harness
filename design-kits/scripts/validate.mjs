#!/usr/bin/env node
// Validate design kits. Usage: node scripts/validate.mjs [kit-id] [--root <folder>]
// Mirrors the app's manifest schema and folder checks, re-implemented by hand.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
// Same ceilings as the app.
const LIMITS = {
  expandedBytes: 25 * 1024 * 1024, entries: 2000, fileBytes: 8 * 1024 * 1024,
  maxDepth: 8, manifestBytes: 1024 * 1024, uiJsBytes: 32 * 1024,
  snippetChars: 4096, components: 200, props: 32,
};
const EXTENSIONS = [".md", ".css", ".js", ".json", ".html", ".svg", ".woff2", ".png", ".jpg", ".webp"];
const REQUIRED_FILES = ["index.md", "DESIGN.md", "tokens.css", "ui.css", "components.json"];
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const CONTRACT = /^\d+\.\d+$/;
const IN_URL = /url\(\s*['"]?([^'")\s]+)/gi;
const IN_IMPORT = /@import\s+(?:url\(\s*)?['"]([^'"]+)/gi;
const IN_ATTR = /\b(?:src|href|srcset|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi;
const BARE_REMOTE = /https?:\/\/[^\s"'<>()]*/gi;
const IS_REMOTE = /^(?:https?:\/\/|\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+)/i;
const W3_NAMESPACE = /^https?:\/\/www\.w3\.org(?:\/|$)/i;
const SCRIPT_TAG = /<\s*script\b/i;
const INLINE_HANDLER = /\son[a-z]+\s*=/i;
const JAVASCRIPT_URL = /javascript:/i;

// Remote references in text, except the SVG namespace, which is not a fetch.
function remoteUrls(text) {
  const found = new Set();
  const add = (raw) => {
    const url = (raw || "").trim();
    if (url && IS_REMOTE.test(url) && !W3_NAMESPACE.test(url)) found.add(url);
  };
  for (const m of text.matchAll(IN_URL)) add(m[1]);
  for (const m of text.matchAll(IN_IMPORT)) add(m[1]);
  for (const m of text.matchAll(IN_ATTR)) add(m[1] ?? m[2] ?? m[3]);
  for (const m of text.matchAll(BARE_REMOTE)) add(m[0]);
  return [...found];
}
// Why markup is unsafe to render, or null when it is fine.
function unsafeHtml(html) {
  if (SCRIPT_TAG.test(html)) return "has a <script> tag";
  if (INLINE_HANDLER.test(html)) return "has an inline on* handler";
  if (JAVASCRIPT_URL.test(html)) return "has a javascript: URL";
  return null;
}
// Scalar frontmatter fields, keys lowercased; empty without any.
function frontmatter(text) {
  const fields = new Map();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const end = lines[0]?.trim() === "---" ? lines.findIndex((l, i) => i > 0 && l.trim() === "---") : -1;
  if (end === -1) return fields;
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    fields.set(m[1].toLowerCase(), value);
  }
  return fields;
}

// Walk a kit folder without following links. Links and odd entries are faults.
function walk(dir) {
  const files = new Map();
  const errors = [];
  let count = 0;
  let total = 0;
  const visit = (abs, rel, depth) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch (err) { return void errors.push(`${rel || "."}: folder cannot be read (${err.message})`); }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (++count > LIMITS.entries) return void errors.push(`${relPath}: the kit is over ${LIMITS.entries} entries`);
      if (entry.isSymbolicLink()) { errors.push(`${relPath}: symbol links are not allowed in a kit`); continue; }
      if (entry.isDirectory()) {
        if (depth + 1 > LIMITS.maxDepth) { errors.push(`${relPath}/: folder is deeper than ${LIMITS.maxDepth}`); continue; }
        visit(join(abs, entry.name), relPath, depth + 1); continue;
      }
      if (!entry.isFile()) { errors.push(`${relPath}: is not a plain file or folder`); continue; }
      const ext = extname(entry.name).toLowerCase();
      if (!EXTENSIONS.includes(ext)) { errors.push(`${relPath}: file type ${ext || "(none)"} is not allowed (allowed: ${EXTENSIONS.join(" ")})`); continue; }
      let size;
      try { size = statSync(join(abs, entry.name)).size; } catch (err) { errors.push(`${relPath}: file cannot be read (${err.message})`); continue; }
      files.set(relPath, size);
      total += size;
      if (size > LIMITS.fileBytes) errors.push(`${relPath}: ${size} bytes is over ${LIMITS.fileBytes}`);
      if (total > LIMITS.expandedBytes) return void errors.push(`${relPath}: the kit is over ${LIMITS.expandedBytes} bytes expanded`);
    }
  };
  visit(dir, "", 0);
  return { files, errors };
}

// A walked kit file as text, or null when it would not read.
function readKit(dir, files, rel) {
  if (!files.has(rel)) return null;
  try { return readFileSync(join(dir, rel), "utf-8"); } catch { return null; }
}
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v, min = 0, max) => typeof v === "string" && v.length >= min && (max === undefined || v.length <= max);
// Check components.json. Returns the manifest when sound, and pushes problems either way.
function parseManifest(text, problems) {
  if (Buffer.byteLength(text, "utf-8") > LIMITS.manifestBytes) return void problems.push(`components.json: over ${LIMITS.manifestBytes} bytes`);
  let data;
  try { data = JSON.parse(text); } catch (err) { return void problems.push(`components.json: not valid JSON (${err.message})`); }
  if (!isObject(data)) return void problems.push("(root): expected an object");
  const shape = [];
  const fail = (path, message) => shape.push(`${path}: ${message}`);
  const opt = (obj, key, ok, at, message) => { if (obj[key] !== undefined && !ok(obj[key])) fail(at, message); };
  if (!isString(data.kitId) || !SLUG.test(data.kitId)) fail("kitId", "must be a lowercase slug (a-z, 0-9, dashes)");
  if (!isString(data.name, 1, 80)) fail("name", "must be a string of 1 to 80 characters");
  if (!isString(data.version) || !VERSION.test(data.version)) fail("version", "must be a version like 1.2.3");
  if (!isString(data.contractVersion) || !CONTRACT.test(data.contractVersion)) fail("contractVersion", "must be a contract version like 1.0");
  opt(data, "package", (v) => isString(v, 1, 200), "package", "must be a string of 1 to 200 characters");
  const themes = [];
  if (!isObject(data.compat)) fail("compat", "is required");
  else {
    if (!Array.isArray(data.compat.themes)) fail("compat.themes", "must be an array");
    else data.compat.themes.forEach((theme, i) => {
      if (!isString(theme, 1)) fail(`compat.themes.${i}`, "must be a non-empty string");
      else if (theme !== "*" && !SLUG.test(theme)) fail(`compat.themes.${i}`, `theme "${theme}" must be "*" or a lowercase slug`);
      else themes.push(theme);
    });
    if (!Array.isArray(data.compat.migratesFrom)) fail("compat.migratesFrom", "must be an array");
    else data.compat.migratesFrom.forEach((f, i) => { if (!isString(f) || !SLUG.test(f)) fail(`compat.migratesFrom.${i}`, "must be a lowercase slug (a-z, 0-9, dashes)"); });
  }
  const components = [];
  if (!Array.isArray(data.components)) fail("components", "must be an array");
  else if (data.components.length < 1 || data.components.length > LIMITS.components) fail("components", `must hold 1 to ${LIMITS.components} components`);
  else data.components.forEach((c, i) => {
    const at = `components.${i}`;
    if (!isObject(c)) return fail(at, "must be an object");
    if (!isString(c.name, 1, 80)) fail(`${at}.name`, "must be a string of 1 to 80 characters");
    if (!isString(c.ui) || !SLUG.test(c.ui)) fail(`${at}.ui`, "must be a lowercase slug (a-z, 0-9, dashes)");
    if (c.kind !== undefined && c.kind !== "component" && c.kind !== "composition") fail(`${at}.kind`, 'must be "component" or "composition"');
    opt(c, "category", (v) => isString(v, 0, 40), `${at}.category`, "must be at most 40 characters");
    opt(c, "description", (v) => isString(v, 0, 300), `${at}.description`, "must be at most 300 characters");
    opt(c, "source", (v) => isString(v, 0, 300), `${at}.source`, "must be at most 300 characters");
    if (!isString(c.snippet, 1, LIMITS.snippetChars)) fail(`${at}.snippet`, `must be a string of 1 to ${LIMITS.snippetChars} characters`);
    if (c.import !== undefined) {
      if (!isObject(c.import)) fail(`${at}.import`, "must be an object");
      else for (const key of ["package", "name"]) if (!isString(c.import[key], 1, 200)) fail(`${at}.import.${key}`, "must be a string of 1 to 200 characters");
    }
    const props = [];
    if (c.props !== undefined && !Array.isArray(c.props)) fail(`${at}.props`, "must be an array");
    else {
      const list = c.props || [];
      if (list.length > LIMITS.props) fail(`${at}.props`, `must hold at most ${LIMITS.props} props`);
      list.forEach((p, j) => {
        const pat = `${at}.props.${j}`;
        if (!isObject(p)) return fail(pat, "must be an object");
        if (!isString(p.name) || !SLUG.test(p.name)) fail(`${pat}.name`, "must be a lowercase slug (a-z, 0-9, dashes)");
        if (!isString(p.label, 1, 80)) fail(`${pat}.label`, "must be a string of 1 to 80 characters");
        if (p.type !== "choice" && p.type !== "boolean" && p.type !== "text") fail(`${pat}.type`, 'must be "choice", "boolean" or "text"');
        if (p.options !== undefined) {
          if (!Array.isArray(p.options) || p.options.length < 1 || p.options.length > 32) fail(`${pat}.options`, "must be an array of 1 to 32 options");
          else p.options.forEach((o, k) => { if (!isString(o, 1)) fail(`${pat}.options.${k}`, "must be a non-empty string"); });
        }
        if (p.default !== undefined && typeof p.default !== "string" && typeof p.default !== "boolean") fail(`${pat}.default`, "must be a string or a boolean");
        props.push(p);
      });
    }
    components.push({ ...c, kind: c.kind || "component", props });
  });

  if (shape.length) { problems.push(...shape); return null; }
  // Cross-field rules, once every field is known to parse.
  const seenUi = new Set();
  components.forEach((c, i) => {
    const at = `components.${i}`;
    if (seenUi.has(c.ui)) problems.push(`${at}.ui: another component already uses data-ui="${c.ui}"`);
    seenUi.add(c.ui);
    const seen = new Set();
    c.props.forEach((p, j) => {
      const pat = `${at}.props.${j}`;
      if (p.name === "ui") problems.push(`${pat}.name: "${c.ui}" has a prop named "ui", which would clash with its data-ui attribute`);
      if (seen.has(p.name)) problems.push(`${pat}.name: "${c.ui}" has two props named "${p.name}"`);
      seen.add(p.name);
      if (p.type === "choice") {
        if (!p.options) problems.push(`${pat}: choice prop "${p.name}" of "${c.ui}" needs options`);
        else if (typeof p.default === "string" && !p.options.includes(p.default)) problems.push(`${pat}: default "${p.default}" of "${c.ui}" prop "${p.name}" is not one of its options`);
      } else if (p.options) problems.push(`${pat}: ${p.type} prop "${p.name}" of "${c.ui}" must not have options`);
      else if (p.type === "boolean" && typeof p.default === "string") problems.push(`${pat}: boolean prop "${p.name}" of "${c.ui}" must default to true or false`);
      else if (p.type === "text" && typeof p.default === "boolean") problems.push(`${pat}: text prop "${p.name}" of "${c.ui}" must default to a string`);
    });
    if (!c.snippet.includes(`data-ui="${c.ui}"`)) problems.push(`${at}.snippet: snippet of "${c.ui}" must contain data-ui="${c.ui}"`);
  });
  return { kitId: data.kitId, name: data.name, version: data.version, themes, components };
}

// Accepts [data-ui="x"], [data-ui='x'] and [data-ui=x], which mean the same in CSS.
function hasSelector(css, ui) {
  return new RegExp(`\\[\\s*data-ui\\s*=\\s*(?:"${ui}"|'${ui}'|${ui})\\s*\\]`).test(css);
}

// Check one kit folder, collecting every problem. Returns its manifest or null.
function validateKitDir(dir, expectedId, problems) {
  try { readdirSync(dir); } catch (err) { return void problems.push(`${dir}: kit folder cannot be read (${err.message})`); }
  const { files, errors } = walk(dir);
  problems.push(...errors);
  for (const name of REQUIRED_FILES) if (!files.has(name)) problems.push(`${name}: required file is missing`);
  const index = readKit(dir, files, "index.md");
  if (index !== null && frontmatter(index).get("type") !== "design-kit") problems.push("index.md: frontmatter must have type: design-kit");
  const raw = readKit(dir, files, "components.json");
  const manifest = raw === null ? null : parseManifest(raw, problems);
  if (manifest && expectedId !== undefined && manifest.kitId !== expectedId) problems.push(`components.json: kitId "${manifest.kitId}" does not match "${expectedId}"`);
  const tokens = readKit(dir, files, "tokens.css");
  if (tokens !== null) {
    if (!tokens.includes("--color-bg:")) problems.push("tokens.css: must define --color-bg:");
    if (!tokens.includes("--color-text:")) problems.push("tokens.css: must define --color-text:");
  }
  // Remote URLs and markup that could run, in every file the canvas renders.
  for (const [rel, size] of files) {
    const ext = extname(rel).toLowerCase();
    if (ext !== ".css" && ext !== ".js" && ext !== ".html" && ext !== ".svg") continue;
    if (size > LIMITS.fileBytes) continue;
    const text = readKit(dir, files, rel);
    if (text === null) continue;
    for (const url of remoteUrls(text)) problems.push(`${rel}: remote URL ${url} (the canvas has no network)`);
    if (ext === ".html" || ext === ".svg") {
      const bad = unsafeHtml(text);
      if (bad) problems.push(`${rel}: ${bad}`);
    }
  }

  const uiJs = files.get("ui.js");
  if (uiJs !== undefined && uiJs > LIMITS.uiJsBytes) problems.push(`ui.js: ${uiJs} bytes is over ${LIMITS.uiJsBytes}`);
  if (manifest) {
    for (const c of manifest.components) {
      const bad = unsafeHtml(c.snippet);
      if (bad) problems.push(`components.json: snippet of "${c.ui}" ${bad}`);
      for (const url of remoteUrls(c.snippet)) problems.push(`components.json: snippet of "${c.ui}" has remote URL ${url}`);
    }
    const css = readKit(dir, files, "ui.css");
    if (css !== null) for (const c of manifest.components) if (c.kind === "component" && !hasSelector(css, c.ui)) problems.push(`ui.css: no [data-ui="${c.ui}"] selector for "${c.name}"`);
    for (const theme of manifest.themes) if (theme !== "*" && !files.has(`themes/${theme}/tokens.css`)) problems.push(`components.json: theme "${theme}" has no themes/${theme}/tokens.css`);
  }
  return manifest;
}

// The kit folders under kits/, in name order.
function kitFolders(kitsDir, problems) {
  try { return readdirSync(kitsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort(); }
  catch (err) { problems.push(`kits: folder cannot be read (${err.message})`); return []; }
}
// Theme folders a kit ships, as names.
function themeFolders(kitDir) {
  try { return readdirSync(join(kitDir, "themes"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}
// Check registry.json against the kits on disk, and its own shape.
function validateRegistry(root, ids, manifests, themeDirs, problems) {
  let data;
  try { data = JSON.parse(readFileSync(join(root, "registry.json"), "utf-8")); }
  catch (err) { return void problems.push(`registry.json: cannot be read or is not valid JSON (${err.message})`); }
  if (!isObject(data)) return void problems.push("registry.json: expected an object");
  if (data.version !== 1) problems.push("registry.json: version must be 1");
  if (!Array.isArray(data.kits)) return void problems.push("registry.json: kits must be an array");
  const listed = new Map();
  data.kits.forEach((kit, i) => {
    const at = `registry.json: kits.${i}`;
    if (!isObject(kit)) return void problems.push(`${at}: must be an object`);
    const ok = isString(kit.id) && SLUG.test(kit.id);
    if (!ok) problems.push(`${at}.id: must be a lowercase slug (a-z, 0-9, dashes)`);
    if (!isString(kit.name, 1, 80)) problems.push(`${at}.name: must be a string of 1 to 80 characters`);
    if (!isString(kit.version) || !VERSION.test(kit.version)) problems.push(`${at}.version: must be a version like 1.2.3`);
    if (!Array.isArray(kit.themes)) problems.push(`${at}.themes: must be an array`);
    if (!isObject(kit.card)) problems.push(`${at}.card: must be an object`);
    else for (const key of ["bg", "text", "accent", "radius"]) if (!has(kit.card, key) || !isString(kit.card[key], 1)) problems.push(`${at}.card.${key}: must be a non-empty string`);
    if (ok) {
      if (listed.has(kit.id)) problems.push(`${at}.id: "${kit.id}" is listed twice`);
      listed.set(kit.id, kit);
    }
  });

  const onDisk = new Set(ids);
  for (const [id, kit] of listed) {
    if (!onDisk.has(id)) { problems.push(`registry.json: "${id}" has no kits/${id} folder`); continue; }
    const manifest = manifests.get(id);
    if (manifest) {
      if (kit.name !== manifest.name) problems.push(`registry.json: "${id}" name "${kit.name}" does not match components.json "${manifest.name}"`);
      if (kit.version !== manifest.version) problems.push(`registry.json: "${id}" version "${kit.version}" does not match components.json "${manifest.version}"`);
    }
    for (const theme of Array.isArray(kit.themes) ? kit.themes : []) {
      if (theme === "*") continue;
      if (!isString(theme) || !SLUG.test(theme)) problems.push(`registry.json: "${id}" theme "${theme}" must be "*" or a lowercase slug`);
      else if (!(themeDirs.get(id) || []).includes(theme)) problems.push(`registry.json: "${id}" theme "${theme}" has no themes/${theme}/ folder in the kit`);
    }
  }
  for (const id of ids) if (!listed.has(id)) problems.push(`registry.json: kit "${id}" is not listed`);
}
function usage(message) {
  process.stderr.write(`validate: ${message}\nusage: node scripts/validate.mjs [kit-id] [--root <folder>]\n`);
  return 2;
}
function main(argv) {
  let root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
  let rootGiven = false;
  let only;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") { if (!argv[i + 1]) return usage("--root needs a folder"); root = argv[++i]; rootGiven = true; }
    else if (arg.startsWith("--root=")) { root = arg.slice(7); if (!root) return usage("--root needs a folder"); rootGiven = true; }
    else if (arg === "--help" || arg === "-h") { process.stdout.write("usage: node scripts/validate.mjs [kit-id] [--root <folder>]\n"); return 0; }
    else if (arg.startsWith("-")) return usage(`unknown option ${arg}`);
    else if (only === undefined) only = arg;
    else return usage(`unexpected argument ${arg}`);
  }
  // A relative --root is read from where the command was run.
  if (rootGiven && !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(root)) root = join(process.cwd(), root);
  const kitsDir = join(root, "kits");
  const scanProblems = [];
  const ids = kitFolders(kitsDir, scanProblems);
  const manifests = new Map();
  const themeDirs = new Map();
  let failed = scanProblems.length > 0;
  for (const problem of scanProblems) process.stdout.write(`${problem}\n`);
  const run = (id) => {
    const problems = [];
    const manifest = validateKitDir(join(kitsDir, id), id, problems);
    if (manifest) manifests.set(id, manifest);
    themeDirs.set(id, themeFolders(join(kitsDir, id)));
    if (!problems.length) return void process.stdout.write(`${id}: ok\n`);
    failed = true;
    for (const problem of problems) process.stdout.write(`${id}: ${problem}\n`);
  };
  if (only !== undefined) {
    if (!ids.includes(only)) { run(only); return 1; } // A folder that is not there reports itself.
    run(only);
    return failed ? 1 : 0;
  }
  for (const id of ids) run(id);
  const registryProblems = [];
  validateRegistry(root, ids, manifests, themeDirs, registryProblems);
  if (registryProblems.length) { failed = true; for (const problem of registryProblems) process.stdout.write(`${problem}\n`); }
  else process.stdout.write("registry: ok\n");
  return failed ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`validate: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
