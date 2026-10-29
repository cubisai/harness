import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExternalMcpServer, McpServerSpec } from "../../shared/types";

/** One server read from an agent's config, as it sits in the file. */
interface ExternalEntry {
  name: string;
  raw: Record<string, unknown>;
}

/** One source of servers: which agent and file, how to list it, and how to turn an entry into a spec. */
interface ExternalGroup {
  agent: string;
  source: string;
  entries: () => ExternalEntry[];
  spec: (raw: Record<string, unknown>) => McpServerSpec | null;
}

/**
 * MCP servers the agents load from their own config, so the Library can
 * show everything an agent will have, not only what the app adds. Read-only,
 * and never values: env vars and headers can hold tokens.
 */
export function readExternalMcp(opts: { home?: string; projectPath?: string | null; env?: NodeJS.ProcessEnv } = {}): ExternalMcpServer[] {
  const out: ExternalMcpServer[] = [];
  for (const group of externalGroups(opts)) {
    for (const { name, raw } of group.entries()) {
      const importable = group.spec(raw) !== null;
      out.push(importable ? { name, agent: group.agent, source: group.source, ...describe(raw), importable: true } : { name, agent: group.agent, source: group.source, ...describe(raw) });
    }
  }
  return out;
}

/** The full spec (values included) of one server readExternalMcp lists, for importing it; null when it isn't there or has no usable shape. Main process only: values never go to the window. */
export function readExternalSpec(agent: string, source: string, name: string, opts: { home?: string; projectPath?: string | null; env?: NodeJS.ProcessEnv } = {}): McpServerSpec | null {
  for (const group of externalGroups(opts)) {
    if (group.agent !== agent || group.source !== source) continue;
    for (const entry of group.entries()) if (entry.name === name) return group.spec(entry.raw);
  }
  return null;
}

/** Every source readExternalMcp and readExternalSpec consult, in the order they appear in the list. */
function externalGroups(opts: { home?: string; projectPath?: string | null; env?: NodeJS.ProcessEnv }): ExternalGroup[] {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const project = opts.projectPath ?? null;
  const groups: ExternalGroup[] = [];

  // Claude Code: user scope and this project's local scope in ~/.claude.json, project scope in .mcp.json.
  const claudeDir = env.CLAUDE_CONFIG_DIR;
  const claudeJson = readJson(claudeDir ? join(claudeDir, ".claude.json") : join(home, ".claude.json"));
  groups.push({ agent: "Claude", source: "~/.claude.json", entries: () => jsonEntries(claudeJson?.mcpServers), spec: (raw) => jsonSpec("claude", raw) });
  if (project) {
    const projects = claudeJson?.projects as Record<string, { mcpServers?: Record<string, unknown> }> | undefined;
    groups.push({ agent: "Claude", source: "~/.claude.json (this project)", entries: () => jsonEntries(projects?.[project]?.mcpServers), spec: (raw) => jsonSpec("claude", raw) });
    groups.push({ agent: "Claude", source: ".mcp.json", entries: () => jsonEntries(readJson(join(project, ".mcp.json"))?.mcpServers), spec: (raw) => jsonSpec("claude", raw) });
  }

  // Codex: [mcp_servers.<name>] tables in config.toml.
  const codexHome = env.CODEX_HOME ?? join(home, ".codex");
  groups.push({ agent: "Codex", source: "~/.codex/config.toml", entries: () => codexEntries(readText(join(codexHome, "config.toml"))), spec: codexSpec });

  // Gemini: mcpServers in settings.json, user and project.
  groups.push({ agent: "Gemini", source: "~/.gemini/settings.json", entries: () => jsonEntries(readJson(join(home, ".gemini", "settings.json"))?.mcpServers), spec: (raw) => jsonSpec("gemini", raw) });
  if (project) groups.push({ agent: "Gemini", source: ".gemini/settings.json", entries: () => jsonEntries(readJson(join(project, ".gemini", "settings.json"))?.mcpServers), spec: (raw) => jsonSpec("gemini", raw) });

  // OpenCode: "mcp" in opencode.json, user and project.
  const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
  groups.push({ agent: "OpenCode", source: "~/.config/opencode/opencode.json", entries: () => jsonEntries(readJson(join(xdg, "opencode", "opencode.json"))?.mcp), spec: openCodeSpec });
  if (project) groups.push({ agent: "OpenCode", source: "opencode.json", entries: () => jsonEntries(readJson(join(project, "opencode.json"))?.mcp), spec: openCodeSpec });
  return groups;
}

function describe(raw: Record<string, unknown>): Pick<ExternalMcpServer, "type" | "target"> {
  const url = [raw.url, raw.httpUrl, raw.serverUrl].find((u) => typeof u === "string") as string | undefined;
  if (url) return { type: raw.type === "sse" ? "sse" : "http", target: url };
  // OpenCode puts the whole command line in an array.
  const command = Array.isArray(raw.command) ? raw.command.map(String) : typeof raw.command === "string" ? [raw.command] : null;
  if (command) return { type: "stdio", target: [...command, ...(Array.isArray(raw.args) ? raw.args.map(String) : [])].join(" ") };
  return { type: "unknown", target: "" };
}

/** Claude and Gemini JSON entries: a command line, or a URL (they disagree on which key means which transport). */
function jsonSpec(kind: "claude" | "gemini", raw: Record<string, unknown>): McpServerSpec | null {
  if (typeof raw.command === "string") {
    const spec: McpServerSpec = { type: "stdio", command: raw.command };
    const args = argList(raw.args);
    if (args) spec.args = args;
    const env = stringMap(raw.env);
    if (env) spec.env = env;
    return spec;
  }
  const headers = stringMap(raw.headers);
  if (kind === "gemini") {
    // The Gemini CLI reads httpUrl as streamable HTTP and a plain url as the older SSE.
    if (typeof raw.httpUrl === "string") return headers ? { type: "http", url: raw.httpUrl, headers } : { type: "http", url: raw.httpUrl };
    if (typeof raw.url === "string") return headers ? { type: "sse", url: raw.url, headers } : { type: "sse", url: raw.url };
    return null;
  }
  if (typeof raw.url === "string") {
    const type = raw.type === "sse" ? "sse" : "http";
    return headers ? { type, url: raw.url, headers } : { type, url: raw.url };
  }
  return null;
}

/** OpenCode "mcp" entries: a local command array, or a remote URL. */
function openCodeSpec(raw: Record<string, unknown>): McpServerSpec | null {
  if (Array.isArray(raw.command)) {
    const parts = raw.command.filter((c): c is string => typeof c === "string");
    const [command, ...args] = parts;
    if (!command) return null;
    const spec: McpServerSpec = { type: "stdio", command };
    if (args.length) spec.args = args;
    const env = stringMap(raw.environment);
    if (env) spec.env = env;
    return spec;
  }
  if (typeof raw.url === "string") {
    const headers = stringMap(raw.headers);
    return headers ? { type: "http", url: raw.url, headers } : { type: "http", url: raw.url };
  }
  return null;
}

/** Codex entries, parsed by codexEntries. */
function codexSpec(raw: Record<string, unknown>): McpServerSpec | null {
  const headers = stringMap(raw.headers);
  if (typeof raw.url === "string") return headers ? { type: "http", url: raw.url, headers } : { type: "http", url: raw.url };
  if (typeof raw.command === "string") {
    const spec: McpServerSpec = { type: "stdio", command: raw.command };
    const args = argList(raw.args);
    if (args) spec.args = args;
    const env = stringMap(raw.env);
    if (env) spec.env = env;
    return spec;
  }
  return null;
}

function jsonEntries(servers: unknown): ExternalEntry[] {
  if (!servers || typeof servers !== "object") return [];
  const out: ExternalEntry[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (raw && typeof raw === "object") out.push({ name, raw: raw as Record<string, unknown> });
  }
  return out;
}

/** Just the string values of a map, or undefined when it holds none. */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (typeof item === "string") out[key] = item;
  return Object.keys(out).length ? out : undefined;
}

/** The string entries of an array, or undefined when it holds none. */
function argList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length ? out : undefined;
}

function readText(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, "utf-8") : null;
  } catch {
    return null;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  const text = readText(file);
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A TOML string literal's contents, or null for anything else (a number, bool, inline table). */
function tomlString(value: string): string | null {
  const m = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value.trim());
  return m ? (m[1] ?? m[2] ?? "") : null;
}

/** A bare or quoted key, unquoted. */
function tomlKey(value: string): string {
  return tomlString(value) ?? value.trim();
}

/** The string pairs of a single-line inline table like `{ "K" = "v", K2 = 'v2' }`. */
function inlineTable(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = value.trim().replace(/^\{/, "").replace(/\}$/, "");
  for (const part of inner.split(",")) {
    const m = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^']*)'|[A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(part);
    if (!m) continue;
    const v = tomlString(m[2]!);
    if (v !== null) out[tomlKey(m[1]!)] = v;
  }
  return out;
}

/**
 * Just enough TOML for `[mcp_servers.<name>]` tables: command, args, url, the
 * `.env` and `.http_headers` sub-tables, inline `http_headers`, and
 * `bearer_token_env_var` (kept as a literal `Bearer ${VAR}` header).
 */
function codexEntries(toml: string | null): ExternalEntry[] {
  if (!toml) return [];
  const servers = new Map<string, { command?: string; args?: string[]; url?: string; env: Record<string, string>; headers: Record<string, string> }>();
  let current: string | null = null;
  let sub: "env" | "headers" | null = null;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const table = /^\[\s*mcp_servers\.("([^"]+)"|'([^']+)'|[A-Za-z0-9_-]+)(?:\.(env|http_headers))?\s*\]$/.exec(line);
    if (table) {
      current = table[2] ?? table[3] ?? table[1]!;
      sub = table[4] === "env" ? "env" : table[4] === "http_headers" ? "headers" : null;
      if (!servers.has(current)) servers.set(current, { env: {}, headers: {} });
      continue;
    }
    if (line.startsWith("[")) {
      current = null; // another table
      sub = null;
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'(?:[^']*)')\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const s = servers.get(current)!;
    const key = tomlKey(kv[1]!);
    if (sub === "env" || sub === "headers") {
      const v = tomlString(kv[2]!);
      if (v !== null) (sub === "env" ? s.env : s.headers)[key] = v;
      continue;
    }
    if (key === "command" || key === "url") s[key] = tomlString(kv[2]!) ?? kv[2]!;
    else if (key === "args") s.args = [...kv[2]!.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? "");
    else if (key === "http_headers") Object.assign(s.headers, inlineTable(kv[2]!));
    else if (key === "bearer_token_env_var") {
      const v = tomlString(kv[2]!);
      if (v !== null) s.headers.Authorization = `Bearer \${${v}}`;
    }
  }
  return [...servers].map(([name, s]) => ({ name, raw: { command: s.command, args: s.args, url: s.url, env: s.env, headers: s.headers } }));
}

/** Just enough TOML for `[mcp_servers.name]` tables: their command, args, and url. */
export function codexServers(toml: string | null): Pick<ExternalMcpServer, "name" | "type" | "target">[] {
  return codexEntries(toml).map(({ name, raw }) => {
    const url = raw.url as string | undefined;
    const command = raw.command as string | undefined;
    const args = raw.args as string[] | undefined;
    return url
      ? { name, type: "http" as const, target: url }
      : { name, type: command ? ("stdio" as const) : ("unknown" as const), target: [command ?? "", ...(args ?? [])].join(" ").trim() };
  });
}
