import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerEntry, McpServerSpec, McpServerView, McpTestResult } from "../../shared/types";

/** The name the app's own tools use; a user server can't take it. */
export const BUILT_IN_SERVER = "unskilled";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

interface FileShape {
  /** Claude Code's .mcp.json shape, plus `disabled`. */
  mcpServers?: Record<string, (McpServerSpec | { command: string; args?: string[]; env?: Record<string, string> }) & { disabled?: boolean }>;
}

function specOf(raw: Record<string, unknown>): McpServerSpec | null {
  if (typeof raw.url === "string" && raw.type !== "stdio") {
    return { type: "http", url: raw.url, ...(isStringMap(raw.headers) && { headers: raw.headers }) };
  }
  if (typeof raw.command === "string") {
    return {
      type: "stdio",
      command: raw.command,
      ...(Array.isArray(raw.args) && { args: raw.args.map(String) }),
      ...(isStringMap(raw.env) && { env: raw.env }),
    };
  }
  return null;
}

function isStringMap(v: unknown): v is Record<string, string> {
  return Boolean(v) && typeof v === "object" && Object.values(v as object).every((x) => typeof x === "string");
}

export function describeSpec(spec: McpServerSpec): string {
  return spec.type === "http" ? spec.url : [spec.command, ...(spec.args ?? [])].join(" ");
}

export function viewOf(entry: McpServerEntry): McpServerView {
  const { spec } = entry;
  return {
    name: entry.name,
    enabled: entry.enabled,
    type: spec.type,
    target: describeSpec(spec),
    envKeys: spec.type === "stdio" ? Object.keys(spec.env ?? {}) : [],
    headerKeys: spec.type === "http" ? Object.keys(spec.headers ?? {}) : [],
  };
}

/**
 * The MCP servers the app gives every agent, in mcp.json in the data folder,
 * in the same shape as Claude Code's .mcp.json so entries can be copied
 * across. Env and header values may hold tokens: the file is private to
 * the user, and values never go to the window.
 */
export class McpServerStore {
  constructor(private file: string) {}

  list(): McpServerEntry[] {
    if (!existsSync(this.file)) return [];
    let raw: FileShape;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf-8")) as FileShape;
    } catch {
      return [];
    }
    const out: McpServerEntry[] = [];
    for (const [name, value] of Object.entries(raw.mcpServers ?? {})) {
      const spec = value && typeof value === "object" ? specOf(value as Record<string, unknown>) : null;
      if (spec && NAME.test(name) && name !== BUILT_IN_SERVER) out.push({ name, spec, enabled: !value.disabled });
    }
    return out;
  }

  enabled(): McpServerEntry[] {
    return this.list().filter((s) => s.enabled);
  }

  /** Add or replace. Empty env/header values keep the stored ones, so the window can edit without seeing them. */
  save(entry: McpServerEntry, previousName?: string): void {
    if (!NAME.test(entry.name)) throw new Error("Use letters, digits, - and _ for the name (up to 40).");
    if (entry.name === BUILT_IN_SERVER) throw new Error(`"${BUILT_IN_SERVER}" is the app's own server; pick another name.`);
    const list = this.list();
    if (entry.name !== previousName && list.some((s) => s.name === entry.name)) throw new Error(`There's already a server named "${entry.name}".`);
    const old = list.find((s) => s.name === (previousName ?? entry.name));
    const spec = normalize(entry.spec, old?.spec);
    const next = list.filter((s) => s.name !== (previousName ?? entry.name));
    next.push({ ...entry, spec });
    this.write(next);
  }

  remove(name: string): void {
    this.write(this.list().filter((s) => s.name !== name));
  }

  setEnabled(name: string, enabled: boolean): void {
    this.write(this.list().map((s) => (s.name === name ? { ...s, enabled } : s)));
  }

  private write(list: McpServerEntry[]): void {
    const mcpServers: FileShape["mcpServers"] = {};
    for (const s of list) mcpServers[s.name] = { ...s.spec, ...(s.enabled ? {} : { disabled: true }) };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function normalize(spec: McpServerSpec, old: McpServerSpec | undefined): McpServerSpec {
  const keep = (next: Record<string, string> | undefined, prev: Record<string, string> | undefined) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(next ?? {})) {
      const key = k.trim();
      if (!key) continue;
      out[key] = v === "" && prev?.[key] !== undefined ? prev[key] : v;
    }
    return Object.keys(out).length ? out : undefined;
  };
  if (spec.type === "http") {
    const url = spec.url.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("The URL has to start with http:// or https://.");
    const headers = keep(spec.headers, old?.type === "http" ? old.headers : undefined);
    return { type: "http", url, ...(headers && { headers }) };
  }
  const command = spec.command.trim();
  if (!command) throw new Error("Enter the command that starts the server.");
  const env = keep(spec.env, old?.type === "stdio" ? old.env : undefined);
  const args = (spec.args ?? []).filter((a) => a !== "");
  return { type: "stdio", command, ...(args.length && { args }), ...(env && { env }) };
}

// ---- the same servers, in each agent's own format ----

/** Claude Agent SDK `options.mcpServers`. */
export function forClaude(servers: McpServerEntry[]): Record<string, McpServerSpec> {
  return Object.fromEntries(servers.map((s) => [s.name, s.spec]));
}

/** Codex thread config (`mcp_servers`, as in ~/.codex/config.toml). */
export function forCodex(servers: McpServerEntry[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    servers.map((s) => [
      s.name,
      s.spec.type === "http"
        ? { url: s.spec.url, ...(s.spec.headers && { http_headers: s.spec.headers }) }
        : { command: s.spec.command, args: s.spec.args ?? [], ...(s.spec.env && { env: s.spec.env }) },
    ]),
  );
}

type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: "http"; name: string; url: string; headers: { name: string; value: string }[] };

/** ACP `mcpServers` for session/new: stdio always, HTTP only when the agent says it can. */
export function forAcp(servers: McpServerEntry[], http: boolean): AcpMcpServer[] {
  const pairs = (m: Record<string, string> | undefined) => Object.entries(m ?? {}).map(([name, value]) => ({ name, value }));
  return servers.flatMap((s): AcpMcpServer[] => {
    if (s.spec.type === "stdio") return [{ name: s.name, command: s.spec.command, args: s.spec.args ?? [], env: pairs(s.spec.env) }];
    return http ? [{ type: "http", name: s.name, url: s.spec.url, headers: pairs(s.spec.headers) }] : [];
  });
}

/** Connect, list the server's tools, disconnect. */
export async function testServer(spec: McpServerSpec, timeoutMs = 20_000): Promise<McpTestResult> {
  const client = new Client({ name: "unskilled", version: "1.0.0" });
  const transport =
    spec.type === "http"
      ? new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } })
      : new StdioClientTransport({ command: spec.command, args: spec.args ?? [], env: { ...getDefaultEnvironment(), ...spec.env }, stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer in ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    const { tools } = await Promise.race([client.listTools(), timeout]);
    return { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })) };
  } catch (err) {
    return { ok: false, tools: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
