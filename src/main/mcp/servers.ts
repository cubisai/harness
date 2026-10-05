import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpOAuthConfig, McpServerEntry, McpServerSpec, McpServerView, McpTestResult } from "../../shared/types";
import { stableStringify } from "../cache-policy";
import { killPidTree } from "../winspawn";
import { clientTransport } from "./transport";
import { expandEnvRefs, isSecretValue, VAULT_MARK, type McpVault, type VaultEntry } from "./vault";

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
    const oauth = oauthOf(raw.oauth);
    return { type: raw.type === "sse" ? "sse" : "http", url: raw.url, ...(isStringMap(raw.headers) && { headers: raw.headers }), ...(oauth && { oauth }) };
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

function oauthOf(raw: unknown): McpOAuthConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const out: McpOAuthConfig = {
    ...(typeof o.clientId === "string" && o.clientId.trim() && { clientId: o.clientId.trim() }),
    ...(typeof o.scopes === "string" && o.scopes.trim() && { scopes: o.scopes.trim() }),
    ...(typeof o.callbackPort === "number" && Number.isInteger(o.callbackPort) && o.callbackPort > 0 && o.callbackPort < 65536 && { callbackPort: o.callbackPort }),
  };
  return out;
}

/** Whether the spec is a URL (Streamable HTTP or SSE) rather than a command. */
export function isRemote(spec: McpServerSpec): spec is Extract<McpServerSpec, { url: string }> {
  return spec.type !== "stdio";
}

function isStringMap(v: unknown): v is Record<string, string> {
  return Boolean(v) && typeof v === "object" && Object.values(v as object).every((x) => typeof x === "string");
}

export function describeSpec(spec: McpServerSpec): string {
  return isRemote(spec) ? spec.url : [spec.command, ...(spec.args ?? [])].join(" ");
}

export function viewOf(entry: McpServerEntry): McpServerView {
  const { spec } = entry;
  return {
    name: entry.name,
    enabled: entry.enabled,
    type: spec.type,
    target: describeSpec(spec),
    envKeys: spec.type === "stdio" ? Object.keys(spec.env ?? {}) : [],
    headerKeys: isRemote(spec) ? Object.keys(spec.headers ?? {}) : [],
    ...(entry.locked && { locked: true }),
    ...(isRemote(spec) && spec.oauth && { oauth: spec.oauth }),
  };
}

/** The values a spec keeps in a map (headers or env), whichever it has. */
function secretMap(spec: McpServerSpec): Record<string, string> | undefined {
  return isRemote(spec) ? spec.headers : spec.env;
}

function withMap(spec: McpServerSpec, map: Record<string, string> | undefined): McpServerSpec {
  const m = map && Object.keys(map).length ? map : undefined;
  if (isRemote(spec)) {
    const { headers: _h, ...rest } = spec;
    return { ...rest, ...(m && { headers: m }) };
  }
  const { env: _e, ...rest } = spec;
  return { ...rest, ...(m && { env: m }) };
}

/**
 * A spec as an agent should get it: ${VAR} references filled from the
 * environment (command, args, URL, headers, env), and any value still locked
 * in the vault left out rather than sent as the placeholder.
 */
export function resolveSpec(spec: McpServerSpec, env: NodeJS.ProcessEnv = process.env): McpServerSpec {
  const x = (v: string) => expandEnvRefs(v, env);
  const map = secretMap(spec);
  const resolved = map ? Object.fromEntries(Object.entries(map).filter(([, v]) => v !== VAULT_MARK).map(([k, v]) => [k, x(v)])) : undefined;
  if (isRemote(spec)) return withMap({ type: spec.type, url: x(spec.url), ...(spec.oauth && { oauth: spec.oauth }) }, resolved);
  return withMap({ type: "stdio", command: x(spec.command), ...(spec.args && { args: spec.args.map(x) }) }, resolved);
}

/**
 * The MCP servers the app gives every agent, in mcp.json in the data folder,
 * in the same shape as Claude Code's .mcp.json so entries can be copied
 * across. Env and header values may hold tokens: with a vault, each one is
 * encrypted there and mcp.json says "$vault" in its place (a plain-text file
 * from before the vault is moved over on first read). Values never go to the
 * window. Without a vault (tests) the values stay in the private file.
 */
export class McpServerStore {
  constructor(private file: string, private vault?: McpVault, private scope = "global") {}

  private key(name: string): string {
    return `${this.scope}:${name}`;
  }

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
    let plaintext = false;
    for (const [name, value] of Object.entries(raw.mcpServers ?? {})) {
      const spec = value && typeof value === "object" ? specOf(value as Record<string, unknown>) : null;
      if (!spec || !NAME.test(name) || name === BUILT_IN_SERVER) continue;
      const entry: McpServerEntry = { name, spec, enabled: !value.disabled };
      const map = secretMap(spec);
      if (this.vault && map) {
        if (Object.values(map).some(isSecretValue)) plaintext = true;
        if (Object.values(map).includes(VAULT_MARK)) {
          const stored = this.vault.get(this.key(name));
          const from = (isRemote(spec) ? stored?.headers : stored?.env) ?? {};
          const filled = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === VAULT_MARK ? (from[k] ?? VAULT_MARK) : v]));
          entry.spec = withMap(spec, filled);
          if (Object.values(filled).includes(VAULT_MARK)) entry.locked = true;
        }
      }
      out.push(entry);
    }
    // A file written before the vault existed: move its values into the vault now.
    if (plaintext && this.vault?.available) this.write(out, this.offGlobalOf(raw));
    return out;
  }

  enabled(): McpServerEntry[] {
    return this.list().filter((s) => s.enabled);
  }

  /** Global servers this project switches off, as stored in the file. */
  offGlobal(): string[] {
    return this.offGlobalOf(this.read());
  }

  private offGlobalOf(raw: FileShape): string[] {
    const off = raw.offGlobal;
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
    if (this.vault && !this.vault.available) {
      const before = old ? secretMap(old.spec) : undefined;
      const added = Object.entries(secretMap(spec) ?? {}).some(([k, v]) => isSecretValue(v) && before?.[k] !== v);
      if (added) throw new Error("This computer can't encrypt secrets (no OS keychain), so they can't be saved. Use ${VAR} to read the value from an environment variable instead.");
    }
    const next = list.filter((s) => s.name !== (previousName ?? entry.name));
    // A rename keeps the server's sign-in: move its vault entry before the write drops the old key.
    if (this.vault && previousName && previousName !== entry.name) this.vault.rename(this.key(previousName), this.key(entry.name));
    const { locked: _l, ...rest } = entry;
    next.push({ ...rest, spec });
    this.write(next);
  }

  remove(name: string): void {
    this.write(this.list().filter((s) => s.name !== name));
  }

  setEnabled(name: string, enabled: boolean): void {
    this.write(this.list().map((s) => (s.name === name ? { ...s, enabled } : s)));
  }

  private write(list: McpServerEntry[], offGlobal?: string[]): void {
    const off = offGlobal ?? this.offGlobal();
    const mcpServers: FileShape["mcpServers"] = {};
    for (const s of list) mcpServers[s.name] = { ...this.vaulted(s), ...(s.enabled ? {} : { disabled: true }) };
    // Secrets of servers that are gone (removed or renamed) leave the vault too.
    if (this.vault) {
      const keep = new Set(list.map((s) => this.key(s.name)));
      for (const k of this.vault.keys(`${this.scope}:`)) if (!keep.has(k)) this.vault.remove(k);
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mcpServers, ...(off.length ? { offGlobal: off } : {}) }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /**
   * The spec as mcp.json stores it: with a usable vault, every secret value is
   * encrypted there first and replaced by the mark. Where the vault can't
   * encrypt, values already in the file stay as they were (save refuses new ones).
   */
  private vaulted(s: McpServerEntry): McpServerSpec {
    const map = secretMap(s.spec);
    if (!this.vault?.available || !map) return s.spec;
    const secret: Record<string, string> = {};
    const shown: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      if (isSecretValue(v)) {
        secret[k] = v;
        shown[k] = VAULT_MARK;
      } else shown[k] = v;
    }
    this.vault.update(this.key(s.name), isRemote(s.spec) ? { headers: secret } : { env: secret });
    return withMap(s.spec, shown);
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

  constructor(private global: McpServerStore, private dir: (projectId: string) => string, private vault?: McpVault) {}

  /** This project's own mcp.json, cached per project id. */
  project(projectId: string): McpServerStore {
    let store = this.projects.get(projectId);
    if (!store) {
      store = new McpServerStore(join(this.dir(projectId), "mcp.json"), this.vault, `project:${projectId}`);
      this.projects.set(projectId, store);
    }
    return store;
  }

  /** The servers the thread's project actually gets, ready to hand to an agent; null project = the global list. */
  effective(projectId: string | null): McpServerEntry[] {
    const ready = (list: McpServerEntry[]) => list.map(({ locked: _l, ...s }) => ({ ...s, spec: resolveSpec(s.spec) }));
    if (!projectId) return ready(this.global.enabled());
    const project = this.project(projectId);
    const ownNames = new Set(project.list().map((s) => s.name));
    const off = new Set(project.offGlobal());
    const fromGlobal = this.global.enabled().filter((s) => !ownNames.has(s.name) && !off.has(s.name));
    return ready([...project.enabled(), ...fromGlobal]);
  }
}

/**
 * Read every mcp.json once (global, then each project folder that has one), so
 * any plain-text value from before the vault is moved into it. Reading is what
 * migrates; a failure leaves that file as it was. Never throws.
 */
export function migrateMcpSecrets(global: McpServerStore, scopes: McpScopes, projectsDir: string): void {
  const read = (store: McpServerStore) => {
    try {
      store.list();
    } catch (err) {
      console.error(`MCP secrets: couldn't move a server's values into the vault: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  read(global);
  let ids: string[] = [];
  try {
    ids = readdirSync(projectsDir).filter((id) => existsSync(join(projectsDir, id, "mcp.json")));
  } catch {
    // No projects folder yet.
  }
  for (const id of ids) read(scopes.project(id));
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
  if (isRemote(spec)) {
    const url = spec.url.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("The URL has to start with http:// or https://.");
    const headers = keep(spec.headers, old && isRemote(old) ? old.headers : undefined);
    const oauth = oauthOf(spec.oauth);
    return { type: spec.type, url, ...(headers && { headers }), ...(oauth && Object.keys(oauth).length && { oauth }) };
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
  return Object.fromEntries(servers.map((s) => [s.name, wireSpec(s.spec)]));
}

/** The spec without the app's own settings (OAuth), as an agent's config takes it. */
function wireSpec(spec: McpServerSpec): McpServerSpec {
  if (!isRemote(spec) || !spec.oauth) return spec;
  const { oauth: _o, ...rest } = spec;
  return rest;
}

/** Codex thread config (`mcp_servers`, as in ~/.codex/config.toml). */
export function forCodex(servers: McpServerEntry[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    servers.map((s) => [
      s.name,
      isRemote(s.spec)
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
  return { servers: forAcp(servers, http), dropped: http ? [] : servers.filter((s) => isRemote(s.spec)).map((s) => s.name) };
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

/** One tool as a server described it, schema included: what the Context sheet prices. */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** A pid is still running (signal 0 only probes). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Connect, list the server's tools with their schemas, disconnect. */
export async function listServerTools(spec: McpServerSpec, timeoutMs = 20_000): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const client = new Client({ name: "cubiq", version: "1.0.0" });
  const transport = clientTransport(spec);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer in ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    const { tools } = await Promise.race([client.listTools(), timeout]);
    return { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema })) };
  } catch (err) {
    return { ok: false, tools: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    // The pid is read before close: the transport clears it as it shuts the child down.
    const pid = transport instanceof StdioClientTransport ? transport.pid : null;
    clearTimeout(timer);
    await client.close().catch(() => {});
    // A hung server can ignore the close; end its tree so it isn't left running.
    if (pid !== null && alive(pid)) killPidTree(pid);
  }
}

/** Connect, list the server's tools, disconnect. */
export async function testServer(spec: McpServerSpec, timeoutMs = 20_000): Promise<McpTestResult> {
  const r = await listServerTools(spec, timeoutMs);
  return { ok: r.ok, tools: r.tools.map(({ name, description }) => ({ name, description })), ...(r.error !== undefined && { error: r.error }) };
}

interface McpToolsEntry {
  at: number;
  ok: boolean;
  tools: McpToolInfo[];
  error?: string;
}

/**
 * The enabled MCP servers' tool schemas, listed once per spec and kept for the
 * Context sheet. An ok listing lives 10 minutes and a failure 1, so a server
 * that is down isn't re-probed on every open. Concurrent asks share one listing.
 */
export class McpToolsCache {
  private entries = new Map<string, McpToolsEntry>();
  private inflight = new Map<string, Promise<void>>();

  constructor(private list = listServerTools, private now = () => Date.now()) {}

  /** The cached listing for this spec, or null when there isn't a fresh one. */
  peek(spec: McpServerSpec): { ok: boolean; tools: McpToolInfo[]; error?: string } | null {
    const entry = this.entries.get(stableStringify(spec));
    if (!entry) return null;
    if (this.now() - entry.at >= (entry.ok ? 600_000 : 60_000)) return null;
    return { ok: entry.ok, tools: entry.tools, ...(entry.error !== undefined && { error: entry.error }) };
  }

  /** List every enabled server without a fresh listing; never throws. */
  async refresh(servers: McpServerEntry[], timeoutMs = 5_000): Promise<void> {
    await Promise.all(
      servers
        .filter((s) => s.enabled === true && this.peek(s.spec) === null)
        .map((s) => {
          const key = stableStringify(s.spec);
          const running = this.inflight.get(key);
          if (running) return running;
          const run = this.list(s.spec, timeoutMs)
            .then((r) => {
              this.entries.set(key, { at: this.now(), ok: r.ok, tools: r.tools, ...(r.error !== undefined && { error: r.error }) });
            })
            .catch(() => {
              // listServerTools never throws, but the sheet must survive one that does.
              this.entries.set(key, { at: this.now(), ok: false, tools: [], error: "failed" });
            })
            .finally(() => this.inflight.delete(key));
          this.inflight.set(key, run);
          return run;
        }),
    );
  }
}
