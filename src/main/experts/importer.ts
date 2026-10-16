import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import JSZip from "jszip";

/**
 * Install "expert packages" (the CodeBuddy/WorkBuddy plugin format) from a
 * GitHub URL, a local folder or a local .zip, converting them to CubiQ's own
 * expert markdown under the app's user experts folder.
 *
 * The input is untrusted: every path in the package is validated, the archive
 * is size-capped, nothing is ever executed or imported, and output paths are
 * asserted to stay inside the target folder.
 */

/** Default download/archive cap (50 MB). */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/** Hard cap on entries in one package. */
const MAX_FILES = 3000;
/** Hard cap on the total uncompressed size of a package. */
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
/** An avatar above this is dropped rather than copied. */
const MAX_AVATAR_BYTES = 1024 * 1024;

const PLUGIN_MANIFEST = ".codebuddy-plugin/plugin.json";
const MARKETPLACE_MANIFEST = ".codebuddy-plugin/marketplace.json";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ImportSource =
  | { kind: "github"; owner: string; repo: string; ref: string | null; subpath: string }
  | { kind: "folder"; path: string }
  | { kind: "zip"; path: string };

export interface ImportCandidate {
  name: string;
  description: string;
  /** Package path inside the source ("" for the root). */
  root: string;
}

export interface ImportResult {
  installed: string[];
  candidates: ImportCandidate[];
  skipped: { name: string; reason: string }[];
}

interface Localized {
  en?: string;
  zh?: string;
}

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  agents: string[];
  skills: string[];
  expertType: "agent" | "team";
  agentName: string;
  teamInfo: { leadAgent: string; memberAgents: string[] } | null;
  displayName: string;
  profession: string;
  displayDescription: string;
  avatar: string;
  categoryId: string;
  defaultInitPrompt: string;
  tags: string[];
  quickPrompts: string[];
}

interface AgentFile {
  /** Path relative to the package root, e.g. "agents/wen.md". */
  ref: string;
  name: string;
  description: string;
  displayName: string;
  profession: string;
  body: string;
}

/** Parse a user-typed source into a concrete location, or null when unusable. */
export function parseSource(input: string): ImportSource | null {
  const text = input.trim();
  if (!text || text.includes("\0")) return null;

  const github = /^https:\/\/github\.com\/([\w.-]{1,100})\/(.+)$/.exec(text);
  if (github) {
    const owner = github[1]!;
    const parts = github[2]!.split("/");
    let repo = parts[0] ?? "";
    if (repo.endsWith(".git")) repo = repo.slice(0, -4);
    if (!/^[\w.-]{1,100}$/.test(repo)) return null;
    const rest = parts.slice(1);
    let ref: string | null = null;
    let subpath = "";
    if (rest[0] === "tree" && rest.length >= 2) {
      ref = rest[1]!;
      subpath = rest
        .slice(2)
        .filter((p) => p.length > 0)
        .join("/");
    }
    if (subpath.split("/").includes("..")) return null;
    return { kind: "github", owner, repo, ref, subpath };
  }

  if (!isAbsolute(text)) return null;
  if (text.split(/[\\/]/).includes("..")) return null;
  if (/\.zip$/i.test(text)) return { kind: "zip", path: text };
  return { kind: "folder", path: text };
}

/** The public URL a package came from, for the expert's `sourceUrl`. */
function sourceUrlOf(source: ImportSource): string {
  if (source.kind === "github") {
    let url = `https://github.com/${source.owner}/${source.repo}`;
    if (source.ref) url = `${url}/tree/${source.ref}`;
    if (source.subpath) url = `${url}/${source.subpath}`;
    return url;
  }
  return source.path;
}

/**
 * Install expert packages. Returns the ids installed, the marketplace
 * candidates offered (when a pick is needed) and anything skipped with a
 * reason. Throws on an unusable source.
 */
export async function importExperts(input: string, opts: { userDir: string; pick?: string[]; fetch?: typeof fetch; maxBytes?: number }): Promise<ImportResult> {
  const source = parseSource(input);
  if (!source) throw new Error("Paste a GitHub link, or pick a folder or a .zip.");

  const tree = await loadTree(source, opts);
  const sourceUrl = sourceUrlOf(source);

  // A marketplace root offers its plugins as candidates.
  const marketplace = tree.get(MARKETPLACE_MANIFEST);
  if (marketplace) {
    const candidates = readMarketplace(decode(marketplace));
    if (!opts.pick) return { installed: [], candidates, skipped: [] };
    const installed: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const name of opts.pick) {
      // By its marketplace name, or by the expert id it installs as (an update re-picks by id).
      const candidate = candidates.find((c) => c.name === name || slugify(c.name) === name);
      if (!candidate) {
        skipped.push({ name, reason: "not in this marketplace" });
        continue;
      }
      try {
        const built = buildPackage({ tree, pkgRoot: candidate.root, plugin: readPlugin(tree, candidate.root), sourceUrl, license: detectLicense(tree, [candidate.root, ""]) });
        writeAtomic(opts.userDir, built.id, built.files);
        installed.push(built.id);
      } catch (error) {
        skipped.push({ name, reason: errorText(error) });
      }
    }
    return { installed, candidates, skipped };
  }

  // A plugin root installs one expert.
  if (tree.has(PLUGIN_MANIFEST)) {
    const built = buildPackage({ tree, pkgRoot: "", plugin: readPlugin(tree, ""), sourceUrl, license: detectLicense(tree, [""]) });
    writeAtomic(opts.userDir, built.id, built.files);
    return { installed: [built.id], candidates: [], skipped: [] };
  }

  // A bare root: each agents/*.md is a single expert.
  const installed: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const built of buildBareAgents(tree, sourceUrl)) {
    writeAtomic(opts.userDir, built.id, built.files);
    installed.push(built.id);
  }
  return { installed, candidates: [], skipped };
}

/** Delete one imported expert folder. A no-op when it is already gone. */
export function removeImportedExpert(userDir: string, id: string): void {
  if (!ID_RE.test(id)) throw new Error("Invalid expert id.");
  rmSync(join(userDir, id), { recursive: true, force: true });
}

/** Load the source as a virtual tree of posix-relative paths → bytes. */
async function loadTree(source: ImportSource, opts: { fetch?: typeof fetch; maxBytes?: number }): Promise<Map<string, Uint8Array>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (source.kind === "github") {
    const doFetch = opts.fetch ?? fetch;
    const url = `https://api.github.com/repos/${source.owner}/${source.repo}/zipball${source.ref ? "/" + encodeURIComponent(source.ref) : ""}`;
    const res = await doFetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "CubiQ" } });
    if (!res.ok) throw new Error(`GitHub request failed with status ${res.status}.`);
    const declared = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Package is too large.");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Package is too large.");
    const tree = await unzipTree(bytes, "always");
    return source.subpath ? reroot(tree, source.subpath) : tree;
  }

  if (source.kind === "zip") {
    const bytes = new Uint8Array(readFileSync(source.path));
    if (bytes.byteLength > maxBytes) throw new Error("Package is too large.");
    return unzipTree(bytes, "common");
  }

  return walkFolder(source.path);
}

/** Keep only entries under `subpath`, re-rooted to the subpath's parent. */
function reroot(tree: Map<string, Uint8Array>, subpath: string): Map<string, Uint8Array> {
  const prefix = normalizeRef(subpath);
  if (!prefix) return tree;
  const out = new Map<string, Uint8Array>();
  for (const [key, bytes] of tree) {
    if (key === prefix) continue;
    if (key.startsWith(prefix + "/")) out.set(key.slice(prefix.length + 1), bytes);
  }
  return out;
}

/** Read a folder recursively, guarding every path and skipping dot-dirs/symlinks. */
function walkFolder(root: string): Map<string, Uint8Array> {
  const tree = new Map<string, Uint8Array>();
  const stack: string[] = [""];
  let total = 0;
  while (stack.length) {
    const rel = stack.pop()!;
    const dir = rel ? join(root, rel) : root;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (entry.name === "node_modules") continue;
        if (entry.name.startsWith(".") && entry.name !== ".codebuddy-plugin") continue;
        stack.push(childRel);
        continue;
      }
      if (!stat.isFile()) continue;
      assertSafePath(childRel);
      if (tree.size >= MAX_FILES) throw new Error("Package has too many files.");
      const bytes = new Uint8Array(readFileSync(full));
      total += bytes.byteLength;
      if (total > MAX_TOTAL_BYTES) throw new Error("Package is too large.");
      tree.set(childRel, bytes);
    }
  }
  return tree;
}

/**
 * Unzip into a virtual tree, validating every entry's original name (JSZip
 * sanitizes `.name`, so `unsafeOriginalName` is what catches zip-slip). `strip`
 * removes a single top-level folder: always for GitHub's `<owner>-<repo>-<sha>/`
 * archive, or only when every entry shares one for a user zip.
 */
async function unzipTree(buf: Uint8Array, strip: "always" | "common"): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const names = entries.map((f) => f.unsafeOriginalName ?? f.name);
  for (const name of names) assertSafePath(name);
  if (entries.length > MAX_FILES) throw new Error("Package has too many files.");

  let stripPrefix = "";
  if (strip === "always") {
    stripPrefix = (names[0] ?? "").split("/")[0] ?? "";
  } else {
    const tops = new Set(names.map((n) => n.split("/")[0] ?? ""));
    if (tops.size === 1 && names.every((n) => n.includes("/"))) stripPrefix = [...tops][0]!;
  }

  const tree = new Map<string, Uint8Array>();
  let total = 0;
  for (let i = 0; i < entries.length; i++) {
    const raw = names[i]!;
    let rel = raw;
    if (stripPrefix && rel.startsWith(stripPrefix + "/")) rel = rel.slice(stripPrefix.length + 1);
    else if (stripPrefix && rel === stripPrefix) continue;
    if (!rel || rel.endsWith("/")) continue;
    assertSafePath(rel);
    const bytes = new Uint8Array(await entries[i]!.async("uint8array"));
    total += bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) throw new Error("Package is too large.");
    tree.set(rel, bytes);
  }
  return tree;
}

/** Reject any entry whose path could escape the package or the output folder. */
function assertSafePath(path: string): void {
  if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path) || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Unsafe path in package: ${path}`);
  }
}

/** Split a locale object into a single string: en first, then zh, else the plain value. */
function localized(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const o = value as { en?: unknown; zh?: unknown };
    return str(o.en) ?? str(o.zh) ?? "";
  }
  return "";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read `plugin.json` into a normalized, defaulted manifest. */
function readPlugin(tree: Map<string, Uint8Array>, pkgRoot: string): PluginManifest {
  const bytes = tree.get(manifestKey(pkgRoot, PLUGIN_MANIFEST));
  const raw = bytes ? parseJson(decode(bytes)) : null;
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const author = o.author && typeof o.author === "object" ? (o.author as Record<string, unknown>) : {};
  const team = o.teamInfo && typeof o.teamInfo === "object" ? (o.teamInfo as Record<string, unknown>) : null;
  return {
    name: str(o.name) ?? "",
    version: str(o.version) ?? "",
    description: str(o.description) ?? "",
    author: str(author.name) ?? "",
    agents: strArray(o.agents),
    skills: strArray(o.skills),
    expertType: o.expertType === "team" ? "team" : "agent",
    agentName: str(o.agentName) ?? "",
    teamInfo: team ? { leadAgent: str(team.leadAgent) ?? "", memberAgents: strArray(team.memberAgents) } : null,
    displayName: localized(o.displayName),
    profession: localized(o.profession),
    displayDescription: localized(o.displayDescription),
    avatar: str(o.avatar) ?? "",
    categoryId: str(o.categoryId) ?? "",
    defaultInitPrompt: localized(o.defaultInitPrompt),
    tags: arrayOf(o.tags).map(localized).filter(Boolean),
    quickPrompts: arrayOf(o.quickPrompts).map(localized).filter(Boolean),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Candidates from a `marketplace.json`, roots stripped of "./" and validated. */
function readMarketplace(text: string): ImportCandidate[] {
  const raw = parseJson(text);
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: ImportCandidate[] = [];
  for (const entry of arrayOf(o.plugins)) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as Record<string, unknown>;
    const root = safeRoot(str(p.source) ?? "");
    if (root === null) continue;
    out.push({ name: str(p.name) ?? "", description: str(p.description) ?? "", root });
  }
  return out;
}

/** Strip a leading "./" and reject a package root that could escape the tree. */
function safeRoot(source: string): string | null {
  const clean = normalizeRef(source);
  if (!clean) return "";
  if (clean.includes("\\") || clean.includes("\0") || clean.split("/").includes("..")) return null;
  return clean;
}

function normalizeRef(ref: string): string {
  return ref.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function manifestKey(pkgRoot: string, manifest: string): string {
  return pkgRoot ? `${pkgRoot}/${manifest}` : manifest;
}

/** Parse an agent markdown's frontmatter (scalars + nested en/zh) and body. */
function parseAgent(text: string, fallbackName: string): AgentFile {
  const lines = text.split(/\r?\n/);
  const scalars = new Map<string, string>();
  const nested = new Map<string, Localized>();
  let body = text;
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end !== -1) {
      let pending: string | null = null;
      for (const line of lines.slice(1, end)) {
        const child = /^\s+(en|zh):\s*(.*)$/.exec(line);
        if (child && pending) {
          const value = unquote(child[2]!.trim());
          const current = nested.get(pending) ?? {};
          if (child[1] === "en") current.en = value;
          else current.zh = value;
          nested.set(pending, current);
          continue;
        }
        const key = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (key) {
          const name = key[1]!.toLowerCase();
          const value = key[2]!.trim();
          if (value === "") pending = name;
          else {
            scalars.set(name, unquote(value));
            pending = null;
          }
        } else {
          pending = null;
        }
      }
      body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
    }
  }
  const read = (key: string): string => {
    const nestedValue = nested.get(key);
    if (nestedValue) return nestedValue.en ?? nestedValue.zh ?? "";
    return scalars.get(key) ?? "";
  };
  const name = scalars.get("name") ?? fallbackName;
  const displayName = read("displayname") || name;
  return {
    ref: "",
    name,
    description: scalars.get("description") ?? "",
    displayName,
    profession: read("profession"),
    body,
  };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Load and parse every agent file a plugin declares (or that a bare root has). */
function loadAgents(tree: Map<string, Uint8Array>, pkgPrefix: string, plugin: PluginManifest): AgentFile[] {
  const refs = plugin.agents.length ? plugin.agents.map(normalizeRef) : discoverAgentRefs(tree, pkgPrefix);
  const out: AgentFile[] = [];
  for (const ref of refs) {
    const bytes = tree.get(pkgPrefix + ref);
    if (!bytes) continue;
    const agent = parseAgent(decode(bytes), posix.basename(ref).replace(/\.md$/i, ""));
    out.push({ ...agent, ref });
  }
  return out;
}

/** Direct `agents/*.md` files under `pkgPrefix`, as package-relative refs. */
function discoverAgentRefs(tree: Map<string, Uint8Array>, pkgPrefix: string): string[] {
  const prefix = `${pkgPrefix}agents/`;
  const refs: string[] = [];
  for (const key of tree.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (rest.includes("/") || !/\.md$/i.test(rest)) continue;
    refs.push(`agents/${rest}`);
  }
  return refs.sort();
}

/** Build one module expert into a set of output-relative files. */
function buildPackage(input: { tree: Map<string, Uint8Array>; pkgRoot: string; plugin: PluginManifest; sourceUrl: string; license: string }): { id: string; files: Map<string, Uint8Array> } {
  const { tree, plugin } = input;
  const pkgPrefix = input.pkgRoot ? `${input.pkgRoot}/` : "";
  const agents = loadAgents(tree, pkgPrefix, plugin);
  if (agents.length === 0) throw new Error("Package has no agents.");

  const leadName = plugin.agentName || plugin.teamInfo?.leadAgent || "";
  const lead = pickAgent(agents, leadName) ?? agents[0]!;
  const name = plugin.displayName || lead.displayName || lead.name;
  const id = slugify(plugin.name || name);
  if (!ID_RE.test(id)) throw new Error("Package has no usable name.");

  const quickPrompts = dedupe([plugin.defaultInitPrompt, ...plugin.quickPrompts]).slice(0, 6);
  const skills = skillRefs(tree, pkgPrefix, plugin).map((ref) => posix.basename(ref));

  const files = new Map<string, Uint8Array>();
  files.set(
    "expert.md",
    encode(
      renderExpert(
        {
          id,
          kind: plugin.expertType,
          name,
          profession: plugin.profession || lead.profession,
          persona: lead.displayName || lead.name,
          category: categoryOf(plugin.categoryId),
          avatar: initials(name),
          description: plugin.displayDescription || plugin.description,
          tags: plugin.tags,
          quickPrompts,
          skills,
          version: plugin.version,
          sourceUrl: input.sourceUrl,
          author: plugin.author,
          license: input.license,
        },
        lead.body,
      ),
    ),
  );

  if (plugin.expertType === "team" && plugin.teamInfo) {
    for (const memberName of plugin.teamInfo.memberAgents) {
      const member = pickAgent(agents, memberName);
      if (!member) continue;
      // The agent's own name is the stable id (a display name may be CJK-only and slug to nothing).
      const memberId = slugify(memberName || member.name);
      if (!ID_RE.test(memberId)) continue;
      files.set(`members/${memberId}.md`, encode(renderMember(member)));
    }
  }

  for (const ref of skillRefs(tree, pkgPrefix, plugin)) {
    const base = posix.basename(ref);
    if (!base || base === ".." || base.includes("\\")) continue;
    const src = `${pkgPrefix}${normalizeRef(ref)}/`;
    for (const [key, bytes] of tree) {
      if (!key.startsWith(src)) continue;
      files.set(`skills/${base}/${key.slice(src.length)}`, bytes);
    }
  }

  if (plugin.avatar) {
    const bytes = tree.get(`${pkgPrefix}${normalizeRef(plugin.avatar)}`);
    if (bytes && bytes.byteLength <= MAX_AVATAR_BYTES) files.set("avatar.png", bytes);
  }

  return { id, files };
}

/** Build each `agents/*.md` in a bare package root as its own single expert. */
function buildBareAgents(tree: Map<string, Uint8Array>, sourceUrl: string): { id: string; files: Map<string, Uint8Array> }[] {
  const out: { id: string; files: Map<string, Uint8Array> }[] = [];
  const license = detectLicense(tree, [""]);
  for (const ref of discoverAgentRefs(tree, "")) {
    const bytes = tree.get(ref);
    if (!bytes) continue;
    const agent = parseAgent(decode(bytes), posix.basename(ref).replace(/\.md$/i, ""));
    const id = slugify(agent.name || posix.basename(ref).replace(/\.md$/i, ""));
    if (!ID_RE.test(id)) continue;
    const files = new Map<string, Uint8Array>();
    files.set(
      "expert.md",
      encode(
        renderExpert(
          {
            id,
            kind: "agent",
            name: agent.displayName || agent.name,
            profession: agent.profession,
            persona: agent.displayName || agent.name,
            category: "Imported",
            avatar: initials(agent.displayName || agent.name),
            description: agent.description,
            tags: [],
            quickPrompts: [],
            skills: skillRefs(tree, "", null).map((r) => posix.basename(r)),
            version: "",
            sourceUrl,
            author: "",
            license,
          },
          agent.body,
        ),
      ),
    );
    out.push({ id, files });
  }
  return out;
}

interface ExpertMeta {
  id: string;
  kind: "agent" | "team";
  name: string;
  profession: string;
  persona: string;
  category: string;
  avatar: string;
  description: string;
  tags: string[];
  quickPrompts: string[];
  skills: string[];
  version: string;
  sourceUrl: string;
  author: string;
  license: string;
}

/** CJK text (Chinese, Japanese, Korean scripts and their punctuation); display fields are kept English-only. */
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/** A display value with no CJK text, else the fallback (CubiQ shows English names only). */
function english(value: string, fallback = ""): string {
  return value && !CJK_RE.test(value) ? value : fallback;
}

/** A display name: English only, and a bare id ("draft-reviewer") reads as words ("Draft reviewer"). */
function displayName(value: string, fallback: string): string {
  const v = english(value);
  if (!v) return fallback;
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(v) ? titleFromId(v) : v;
}

/** "deep-researcher" → "Deep researcher". */
function titleFromId(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

/** `---` frontmatter + body (the shape shared/experts.ts parseExpertMarkdown reads), lists as inline JSON arrays, every value single-line; display fields English-only. */
function renderExpert(raw: ExpertMeta, body: string): string {
  const name = displayName(raw.name, titleFromId(raw.id));
  const meta: ExpertMeta = {
    ...raw,
    name,
    avatar: english(raw.avatar, initials(name)),
    profession: english(raw.profession),
    persona: displayName(raw.persona, ""),
    category: english(raw.category, "Imported"),
    description: english(raw.description),
    tags: raw.tags.filter((t) => english(t)),
    quickPrompts: raw.quickPrompts.filter((q) => english(q)),
    author: english(raw.author),
  };
  const lines = [
    `id: ${meta.id}`,
    `kind: ${meta.kind}`,
    `name: ${oneLine(meta.name)}`,
    `profession: ${oneLine(meta.profession)}`,
    `persona: ${oneLine(meta.persona)}`,
    `category: ${oneLine(meta.category)}`,
    `avatar: ${meta.avatar}`,
    `description: ${oneLine(meta.description)}`,
    `tags: ${JSON.stringify(meta.tags)}`,
    `quickPrompts: ${JSON.stringify(meta.quickPrompts)}`,
    `skills: ${JSON.stringify(meta.skills)}`,
    `version: ${oneLine(meta.version)}`,
    `sourceUrl: ${oneLine(meta.sourceUrl)}`,
    `author: ${oneLine(meta.author)}`,
    `license: ${oneLine(meta.license)}`,
  ];
  const text = `---\n${lines.join("\n")}\n---\n\n${body}`;
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** A team member file: name, profession, description, then the body. */
function renderMember(agent: AgentFile): string {
  const name = displayName(agent.displayName, titleFromId(slugify(agent.name) || "member"));
  const lines = [`name: ${oneLine(name)}`, `profession: ${oneLine(english(agent.profession))}`, `description: ${oneLine(english(agent.description))}`];
  const text = `---\n${lines.join("\n")}\n---\n\n${agent.body}`;
  return text.endsWith("\n") ? text : `${text}\n`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** The lead/member agent by frontmatter name, else by file basename. */
function pickAgent(agents: AgentFile[], name: string): AgentFile | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  return (
    agents.find((a) => a.name.toLowerCase() === lower) ??
    agents.find((a) => posix.basename(a.ref).replace(/\.md$/i, "").toLowerCase() === lower)
  );
}

/** Package-relative skill folder refs, from the manifest or the tree's skills/. */
function skillRefs(tree: Map<string, Uint8Array>, pkgPrefix: string, plugin: PluginManifest | null): string[] {
  if (plugin && plugin.skills.length) return plugin.skills.map(normalizeRef);
  const prefix = `${pkgPrefix}skills/`;
  const names = new Set<string>();
  for (const key of tree.keys()) {
    if (!key.startsWith(prefix)) continue;
    const segment = key.slice(prefix.length).split("/")[0];
    if (segment) names.add(segment);
  }
  return [...names].map((name) => `skills/${name}`);
}

/** "02-Engineering" → "Engineering"; "04-DataAI" → "Data & AI"; default "Imported". */
function categoryOf(categoryId: string): string {
  if (!categoryId) return "Imported";
  const stripped = categoryId.replace(/^\d+-/, "");
  if (!stripped) return "Imported";
  return stripped === "DataAI" ? "Data & AI" : stripped;
}

function initials(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase();
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** The SPDX-ish licence id from a LICENSE file at the package or archive root. */
function detectLicense(tree: Map<string, Uint8Array>, roots: string[]): string {
  for (const root of roots) {
    const prefix = root ? `${root}/` : "";
    for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
      const bytes = tree.get(prefix + name);
      if (!bytes) continue;
      const first = decode(bytes)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? "";
      return spdx(first);
    }
  }
  return "none";
}

function spdx(line: string): string {
  const lower = line.toLowerCase();
  if (/\bmit\b/.test(lower)) return "MIT";
  if (/\bapache\b/.test(lower)) return "Apache-2.0";
  if (/\bbsd\b/.test(lower)) return "BSD";
  if (/\bisc\b/.test(lower)) return "ISC";
  if (/\bmpl\b|\bmozilla\b/.test(lower)) return "MPL-2.0";
  if (/\bgpl\b/.test(lower)) return "GPL";
  if (/\bunlicense\b/.test(lower)) return "Unlicense";
  return "custom";
}

/** Write the files to a temp folder, then swap it into place over any existing one. */
function writeAtomic(userDir: string, id: string, files: Map<string, Uint8Array>): void {
  mkdirSync(userDir, { recursive: true });
  const target = join(userDir, id);
  const tmp = join(userDir, `.tmp-${id}-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    writeTree(tmp, files);
    rmSync(target, { recursive: true, force: true });
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

/** Write every output file, asserting each path stays inside `dir`. */
function writeTree(dir: string, files: Map<string, Uint8Array>): void {
  const rootWithSep = dir.endsWith(sep) ? dir : dir + sep;
  for (const [rel, bytes] of files) {
    assertSafePath(rel);
    const abs = resolve(dir, rel);
    if (!abs.startsWith(rootWithSep)) throw new Error(`Refusing to write outside the experts folder: ${rel}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
