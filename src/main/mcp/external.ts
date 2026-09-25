import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExternalMcpServer } from "../../shared/types";

/**
 * MCP servers the agents load from their own config, so the Library can
 * show everything an agent will have, not only what the app adds. Read-only,
 * and never values: env vars and headers can hold tokens.
 */
export function readExternalMcp(opts: { home?: string; projectPath?: string | null; env?: NodeJS.ProcessEnv } = {}): ExternalMcpServer[] {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const project = opts.projectPath ?? null;
  const out: ExternalMcpServer[] = [];
  const add = (agent: string, source: string, servers: Record<string, unknown> | undefined) => {
    for (const [name, raw] of Object.entries(servers ?? {})) {
      if (raw && typeof raw === "object") out.push({ name, agent, source, ...describe(raw as Record<string, unknown>) });
    }
  };

  // Claude Code: user scope and this project's local scope in ~/.claude.json, project scope in .mcp.json.
  const claudeDir = env.CLAUDE_CONFIG_DIR;
  const claudeJson = readJson(claudeDir ? join(claudeDir, ".claude.json") : join(home, ".claude.json"));
  add("Claude", "~/.claude.json", claudeJson?.mcpServers as Record<string, unknown>);
  if (project) {
    const projects = claudeJson?.projects as Record<string, { mcpServers?: Record<string, unknown> }> | undefined;
    add("Claude", "~/.claude.json (this project)", projects?.[project]?.mcpServers);
    add("Claude", ".mcp.json", readJson(join(project, ".mcp.json"))?.mcpServers as Record<string, unknown>);
  }

  // Codex: [mcp_servers.<name>] tables in config.toml.
  const codexHome = env.CODEX_HOME ?? join(home, ".codex");
  for (const s of codexServers(readText(join(codexHome, "config.toml")))) out.push({ ...s, agent: "Codex", source: "~/.codex/config.toml" });

  // Gemini: mcpServers in settings.json, user and project.
  add("Gemini", "~/.gemini/settings.json", readJson(join(home, ".gemini", "settings.json"))?.mcpServers as Record<string, unknown>);
  if (project) add("Gemini", ".gemini/settings.json", readJson(join(project, ".gemini", "settings.json"))?.mcpServers as Record<string, unknown>);

  // OpenCode: "mcp" in opencode.json, user and project.
  const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
  add("OpenCode", "~/.config/opencode/opencode.json", readJson(join(xdg, "opencode", "opencode.json"))?.mcp as Record<string, unknown>);
  if (project) add("OpenCode", "opencode.json", readJson(join(project, "opencode.json"))?.mcp as Record<string, unknown>);
  return out;
}

function describe(raw: Record<string, unknown>): Pick<ExternalMcpServer, "type" | "target"> {
  const url = [raw.url, raw.httpUrl, raw.serverUrl].find((u) => typeof u === "string") as string | undefined;
  if (url) return { type: raw.type === "sse" ? "sse" : "http", target: url };
  // OpenCode puts the whole command line in an array.
  const command = Array.isArray(raw.command) ? raw.command.map(String) : typeof raw.command === "string" ? [raw.command] : null;
  if (command) return { type: "stdio", target: [...command, ...(Array.isArray(raw.args) ? raw.args.map(String) : [])].join(" ") };
  return { type: "unknown", target: "" };
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

/** Just enough TOML for `[mcp_servers.name]` tables: their command, args, and url. */
export function codexServers(toml: string | null): Pick<ExternalMcpServer, "name" | "type" | "target">[] {
  if (!toml) return [];
  const servers = new Map<string, { command?: string; args?: string[]; url?: string }>();
  let current: string | null = null;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const table = /^\[\s*mcp_servers\.("([^"]+)"|'([^']+)'|[A-Za-z0-9_-]+)\s*\]$/.exec(line);
    if (table) {
      current = table[2] ?? table[3] ?? table[1]!;
      if (!servers.has(current)) servers.set(current, {});
      continue;
    }
    if (line.startsWith("[")) {
      current = null; // another table, including [mcp_servers.x.env]
      continue;
    }
    if (!current) continue;
    const kv = /^(command|url|args)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const s = servers.get(current)!;
    if (kv[1] === "args") s.args = [...kv[2]!.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? "");
    else s[kv[1] as "command" | "url"] = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(kv[2]!)?.slice(1).find((x) => x !== undefined) ?? kv[2]!;
  }
  return [...servers].map(([name, s]) =>
    s.url ? { name, type: "http" as const, target: s.url } : { name, type: s.command ? ("stdio" as const) : ("unknown" as const), target: [s.command ?? "", ...(s.args ?? [])].join(" ").trim() },
  );
}
