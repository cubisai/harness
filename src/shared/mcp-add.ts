// Turn whatever the user pasted (a URL, a command, an `mcp add` line, or JSON
// from another tool's config) into MCP server drafts. Pure: no Node or DOM.

import { splitCommandLine } from "./cmdline";
import type { McpDraft, McpServerSpec } from "./types";

/** Server names an MCP client accepts: a letter or digit first, then up to 39 more of `[A-Za-z0-9_-]`. */
export const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** Read pasted text into one or more server drafts, or an error explaining what was missing. */
export function parseMcpInput(text: string): { drafts: McpDraft[]; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { drafts: [], error: "Paste a URL, a command or JSON config." };

  if (trimmed.startsWith("{")) {
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { drafts: [], error: `That looks like JSON but doesn't parse: ${message}` };
    }
    if (!isRecord(obj)) return { drafts: [], error: "No MCP servers found in that JSON." };
    const drafts = parseJsonConfig(obj);
    if (!drafts.length) return { drafts: [], error: "No MCP servers found in that JSON." };
    return { drafts };
  }

  if (!/\s/.test(trimmed) && /^https?:\/\//.test(trimmed)) {
    let path: string;
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return { drafts: [], error: "That URL isn't complete." };
    }
    const spec: McpServerSpec = { type: path.endsWith("/sse") ? "sse" : "http", url: trimmed };
    return { drafts: [{ name: nameFor(spec), spec }] };
  }

  const tokens = splitCommandLine(trimmed);
  if ((tokens[0] === "claude" || tokens[0] === "codex") && tokens[1] === "mcp" && tokens[2] === "add") {
    return parseAgentAdd(tokens);
  }
  return parseCommandLine(tokens);
}

/** A short, lowercase name for a server, derived from its URL or command. */
export function nameFor(spec: McpServerSpec): string {
  if (spec.type === "http" || spec.type === "sse") return cleanName(hostLabel(spec.url));
  return cleanName(packageName(spec.command, spec.args ?? []));
}

/** Fold any text into a name MCP clients accept: lowercase `[a-z0-9_-]`, at most 40 chars. */
export function cleanName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40);
  return name || "server";
}

/** What a local server's command looks like it might do: sudo, rm -rf, shell pipes, key paths. */
export function commandWarnings(spec: McpServerSpec): string[] {
  if (spec.type !== "stdio") return [];
  const text = [spec.command, ...(spec.args ?? [])].join(" ");
  const out: string[] = [];
  if (/\bsudo\b/.test(text)) out.push("Runs with administrator rights (sudo).");
  if (hasRmRf(text)) out.push("Deletes files (rm -rf).");
  if (/\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh)\b/i.test(text)) out.push("Downloads a script and runs it.");
  if (/;|&|\||`|\$\(/.test(text)) out.push("Has shell operators; they only run if the command is itself a shell.");
  if (/~\/\.ssh|\.ssh\/|id_rsa|id_ed25519|\.aws\/|\.gnupg|\/etc\/|\.kube\/config/i.test(text))
    out.push("Touches sensitive files (keys, credentials or system config).");
  const base = basenameNoExt(spec.command).toLowerCase();
  if (["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"].includes(base)) out.push("Runs a shell.");
  return out;
}

function parseJsonConfig(obj: Record<string, unknown>): McpDraft[] {
  let container: Record<string, unknown> | undefined;
  if (isRecord(obj.mcpServers)) container = obj.mcpServers;
  else if (isRecord(obj.servers)) container = obj.servers;
  else if (isRecord(obj.mcp)) container = obj.mcp;

  const entries: { name?: string; raw: unknown }[] = [];
  if (container) {
    for (const [key, raw] of Object.entries(container)) entries.push({ name: key, raw });
  } else if (hasServerShape(obj)) {
    entries.push({ raw: obj });
  } else {
    for (const [key, raw] of Object.entries(obj)) entries.push({ name: key, raw });
  }

  const drafts: McpDraft[] = [];
  const used = new Set<string>();
  for (const entry of entries) {
    const spec = toSpec(entry.raw);
    if (!spec) continue;
    const base = entry.name === undefined ? nameFor(spec) : cleanName(entry.name);
    drafts.push({ name: uniqueName(base, used), spec });
  }
  return drafts;
}

function parseAgentAdd(tokens: string[]): { drafts: McpDraft[]; error?: string } {
  let transport: string | undefined;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  let afterSeparator = false;
  for (let i = 3; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (afterSeparator) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      afterSeparator = true;
      continue;
    }
    if (token === "--transport" || token === "-t") {
      transport = tokens[i + 1];
      i++;
      continue;
    }
    if (token === "--env" || token === "-e") {
      const pair = tokens[i + 1];
      i++;
      if (pair) {
        const eq = pair.indexOf("=");
        if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      continue;
    }
    if (token === "--header" || token === "-H") {
      const value = tokens[i + 1];
      i++;
      if (value) {
        const colon = value.indexOf(":");
        if (colon > 0) headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
      }
      continue;
    }
    if (token === "--scope" || token === "-s") {
      i++;
      continue;
    }
    positional.push(token);
  }

  const name = positional.shift();
  if (!name) return { drafts: [], error: "Enter the name for the server." };

  if (positional.length === 1 && /^https?:\/\//.test(positional[0]!)) {
    const type = transport === "sse" ? "sse" : "http";
    const url = positional[0]!;
    const spec: McpServerSpec = Object.keys(headers).length ? { type, url, headers } : { type, url };
    return { drafts: [{ name, spec }] };
  }

  const command = positional[0];
  if (!command) return { drafts: [], error: "Enter the command that starts the server." };
  const spec: McpServerSpec = { type: "stdio", command };
  const args = positional.slice(1);
  if (args.length) spec.args = args;
  if (Object.keys(env).length) spec.env = env;
  return { drafts: [{ name, spec }] };
}

function parseCommandLine(tokens: string[]): { drafts: McpDraft[]; error?: string } {
  let i = 0;
  const env: Record<string, string> = {};
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
    const eq = tokens[i]!.indexOf("=");
    env[tokens[i]!.slice(0, eq)] = tokens[i]!.slice(eq + 1);
    i++;
  }
  const command = tokens[i];
  if (!command) return { drafts: [], error: "Enter the command that starts the server." };
  const spec: McpServerSpec = { type: "stdio", command };
  const args = tokens.slice(i + 1);
  if (args.length) spec.args = args;
  if (Object.keys(env).length) spec.env = env;
  return { drafts: [{ name: nameFor(spec), spec }] };
}

function toSpec(raw: unknown): McpServerSpec | null {
  if (!isRecord(raw)) return null;

  const url = firstString(raw.url, raw.httpUrl, raw.serverUrl);
  if (url) {
    const type = raw.type === "sse" || raw.transport === "sse" ? "sse" : "http";
    const headers = stringRecord(raw.headers);
    return headers ? { type, url, headers } : { type, url };
  }

  let command: string | undefined;
  let args: string[] | undefined;
  if (typeof raw.command === "string") {
    command = raw.command;
    args = stringArray(raw.args);
  } else if (Array.isArray(raw.command)) {
    const parts = raw.command.filter((v): v is string => typeof v === "string");
    command = parts[0];
    args = parts.length > 1 ? parts.slice(1) : undefined;
  }
  if (!command) return null;

  const spec: McpServerSpec = { type: "stdio", command };
  if (args) spec.args = args;
  const env = stringRecord(raw.env) ?? stringRecord(raw.environment);
  if (env) spec.env = env;
  return spec;
}

function hasServerShape(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.command === "string" ||
    Array.isArray(obj.command) ||
    typeof obj.url === "string" ||
    typeof obj.httpUrl === "string" ||
    typeof obj.serverUrl === "string"
  );
}

function hostLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return "local";
  const labels = host.split(".").filter(Boolean);
  const drop = new Set(["mcp", "api", "www"]);
  while (labels.length > 1 && drop.has(labels[0]!.toLowerCase())) labels.shift();
  return labels[0] ?? host;
}

function packageName(command: string, args: string[]): string {
  const runner = basenameNoExt(command);
  const valueFlags = new Set(["-e", "--env", "-v", "--volume", "--name", "-p", "--network"]);
  const isContainer = runner === "docker" || runner === "podman" || runner === "nerdctl";

  let pkg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (isContainer && valueFlags.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (arg === "dlx" || arg === "run" || arg === "x" || arg === "exec") continue;
    pkg = arg;
    break;
  }
  if (!pkg) return runner;

  const scope = pkg.startsWith("@") ? pkg.slice(1).split("/")[0] : undefined;
  let name = pkg.replace(/@[^/@]*$/, "").replace(/:[A-Za-z0-9][A-Za-z0-9._-]*$/, "");
  name = name.split("/").pop() ?? name;
  name = name.replace(/\.(js|mjs|py)$/i, "");
  for (const prefix of ["mcp-server-", "server-", "mcp-"]) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  for (const suffix of ["-mcp-server", "-mcp", "-server", "_mcp"]) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  if (!name || name === "mcp") name = scope ?? runner;
  return name || runner;
}

function basenameNoExt(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.[^.]+$/, "");
}

function hasRmRf(text: string): boolean {
  const match = /\brm\b([^;&|\n]*)/.exec(text);
  if (!match) return false;
  const rest = match[1] ?? "";
  return rest.split(/\s+/).some((token) => /^-[A-Za-z]+$/.test(token) && /r/i.test(token) && /f/i.test(token));
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let n = 1;
  while (used.has(name)) {
    n++;
    name = `${base}-${n}`;
  }
  used.add(name);
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length ? out : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
