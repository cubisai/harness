import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerEntry, McpServerSpec, McpServerView, McpTestResult } from "../../shared/types";

/** The name the app's own tools use; a user server can't take it. */
export const BUILT_IN_SERVER = "cubiq";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

interface FileShape {
  /** Claude Code's .mcp.json shape, plus `disabled`. */
  mcpServers?: Record<string, (McpServerSpec | { command: string; args?: string[]; env?: Record<string, string> }) & { disabled?: boolean }>;
  /** Global servers this file's project switches off; names only. */
  offGlobal?: string[];
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

  private read(): FileShape {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf-8")) as FileShape;
    } catch {
      return {};
    }
  }

  list(): McpServerEntry[] {
    const raw = this.read();
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

  /** Global servers this project switches off, as stored in the file. */
  offGlobal(): string[] {
    const off = this.read().offGlobal;
    return Array.isArray(off) ? off.filter((n): n is string => typeof n === "string") : [];
  }

  /** Switch one global server off (or back on) for this project. */
  setGlobalOff(name: string, off: boolean): void {
    const current = this.offGlobal();
    const next = off ? (current.includes(name) ? current : [...current, name]) : current.filter((n) => n !== name);
    this.write(this.list(), next);
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

  private write(list: McpServerEntry[], offGlobal?: string[]): void {
    const mcpServers: FileShape["mcpServers"] = {};
    for (const s of list) mcpServers[s.name] = { ...s.spec, ...(s.enabled ? {} : { disabled: true }) };
    const off = offGlobal ?? this.offGlobal();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mcpServers, ...(off.length ? { offGlobal: off } : {}) }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * The MCP servers the app gives every agent, at two scopes: one global store
 * for all projects, and one file per project. A project's servers replace a
 * same-named global one whole (no field merge); the rest of the globals apply
 * unless the project switches them off.
 */
export class McpScopes {
  private projects = new Map<string, McpServerStore>();

  constructor(private global: McpServerStore, private dir: (projectId: string) => string) {}

  /** This project's own mcp.json, cached per project id. */
  project(projectId: string): McpServerStore {
    let store = this.projects.get(projectId);
    if (!store) {
      store = new McpServerStore(join(this.dir(projectId), "mcp.json"));
      this.projects.set(projectId, store);
    }
    return store;
  }

  /** The servers the thread's project actually gets; null project = the global list. */
  effective(projectId: string | null): McpServerEntry[] {
    if (!projectId) return this.global.enabled();
    const project = this.project(projectId);
    const ownNames = new Set(project.list().map((s) => s.name));
    const off = new Set(project.offGlobal());
    const fromGlobal = this.global.enabled().filter((s) => !ownNames.has(s.name) && !off.has(s.name));
    return [...project.enabled(), ...fromGlobal];
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

/**
 * forAcp, plus the names of the HTTP servers it had to leave out. ACP's
 * `mcpCapabilities.http` defaults to false, so an agent that doesn't report it
 * gets only stdio servers, and the user has to be told which ones went missing.
 */
export function forAcpWithReport(servers: McpServerEntry[], http: boolean): { servers: AcpMcpServer[]; dropped: string[] } {
  return { servers: forAcp(servers, http), dropped: http ? [] : servers.filter((s) => s.spec.type !== "stdio").map((s) => s.name) };
}

/**
 * What changed between two MCP server sets, keyed by server name, as the
 * notice a turn shows when the session is reopened with them; null when
 * nothing changed. Reopening discards the agent's prompt cache, so it's said.
 */
export function mcpChangeNotice(before: Record<string, unknown>, after: Record<string, unknown>, reopened: boolean, agent: string): string | null {
  const added = Object.keys(after).filter((n) => !(n in before));
  const removed = Object.keys(before).filter((n) => !(n in after));
  const changed = Object.keys(after).filter((n) => n in before && JSON.stringify(before[n]) !== JSON.stringify(after[n]));
  if (!added.length && !removed.length && !changed.length) return null;
  // The harness's own tool server goes by "cubiq" on the wire; users know it as the browser tools.
  const label = (names: string[]) => names.map((n) => (n === "cubiq" || n === "unskilled" ? "the app's browser tools" : n)).join(", ");
  const parts = [added.length && `added ${label(added)}`, removed.length && `removed ${label(removed)}`, changed.length && `changed ${label(changed)}`].filter(Boolean);
  return reopened
    ? `MCP servers changed (${parts.join("; ")}), so ${agent}'s session was reopened with them (its prompt cache starts over).`
    : `MCP servers changed (${parts.join("; ")}), but ${agent} can't reopen a session, so the change applies from the next new thread.`;
}

/** Connect, list the server's tools, disconnect. */
export async function testServer(spec: McpServerSpec, timeoutMs = 20_000): Promise<McpTestResult> {
  const client = new Client({ name: "cubiq", version: "1.0.0" });
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
