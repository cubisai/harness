import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";
import type { McpServerEntry, McpServerSpec } from "../../shared/types";
import type { HarnessTool } from "../agents/types";
import { stableStringify } from "../cache-policy";
import { bm25Rank } from "../search/bm25";
import { killPidTree } from "../winspawn";
import { clientTransport, type ClientTransport } from "./transport";
import type { McpToolsCache, McpToolInfo } from "./servers";

/**
 * An MCP router: the agent searches the project's MCP tools and calls one by
 * name, instead of loading every schema. The pool keeps one connection per
 * spec between calls, sweeping idle servers and closing them on shutdown.
 */

type Transport = ClientTransport;

interface PoolEntry {
  client: Client;
  transport: Transport;
  lastUsed: number;
  /** Shared by concurrent callers; set once per entry, before the first await. */
  connecting?: Promise<void>;
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

/** Connect once per spec, call, and keep the client warm until it idles out. */
export class McpClientPool {
  private entries = new Map<string, PoolEntry>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly onToolsChanged?: (spec: McpServerSpec) => void;

  /** `onToolsChanged`: a connected server said its tool list changed (notifications/tools/list_changed). */
  constructor(opts: { connectTimeoutMs?: number; callTimeoutMs?: number; idleMs?: number; now?: () => number; onToolsChanged?: (spec: McpServerSpec) => void } = {}) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 60_000;
    this.idleMs = opts.idleMs ?? 600_000;
    this.now = opts.now ?? (() => Date.now());
    this.onToolsChanged = opts.onToolsChanged;
  }

  /** Call one tool on this server, connecting it first if needed; never throws. */
  async callTool(spec: McpServerSpec, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; isError: boolean }> {
    this.startSweeper();
    const key = stableStringify(spec);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.createEntry(spec);
      this.entries.set(key, entry);
    }
    try {
      if (!entry.connecting) entry.connecting = this.race(entry.client.connect(entry.transport), this.connectTimeoutMs);
      await entry.connecting;
      const result = await this.race(entry.client.callTool({ name, arguments: args }), this.callTimeoutMs);
      entry.lastUsed = this.now();
      const parts: string[] = [];
      const content = (result.content ?? []) as { type: string; text?: string }[];
      for (const part of content) parts.push(part.type === "text" ? (part.text ?? "") : `[${part.type} content omitted]`);
      return { ok: true, text: parts.join("\n"), isError: result.isError === true };
    } catch (err) {
      await this.drop(key, entry);
      return { ok: false, text: err instanceof Error ? err.message : String(err), isError: true };
    }
  }

  /** Close entries idle for at least `idleMs`. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.lastUsed >= this.idleMs) {
        this.entries.delete(key);
        await this.closeEntry(entry);
      }
    }
  }

  /** Close every connection and stop the sweeper. */
  async closeAll(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => this.closeEntry(entry)));
  }

  private createEntry(spec: McpServerSpec): PoolEntry {
    const transport: Transport = clientTransport(spec);
    const client = new Client({ name: "cubiq", version: "1.0.0" });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.onToolsChanged?.(spec));
    return { client, transport, lastUsed: this.now() };
  }

  private async drop(key: string, entry: PoolEntry): Promise<void> {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    await this.closeEntry(entry);
  }

  private async closeEntry(entry: PoolEntry): Promise<void> {
    // The pid is read before close: the transport clears it as it shuts the child down.
    const pid = entry.transport instanceof StdioClientTransport ? entry.transport.pid : null;
    await entry.client.close().catch(() => {});
    // A hung server can ignore the close; end its tree so it isn't left running.
    if (pid !== null && alive(pid)) killPidTree(pid);
  }

  private race<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`No answer in ${Math.round(ms / 1000)} seconds.`)), ms);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  private startSweeper(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), 60_000);
    this.timer.unref();
  }
}

/** Enabled tool count at or above which an agent without native tool search gets the router instead of every schema. */
export const MCP_ROUTER_MIN_TOOLS = 20;

/** Cap on tool names in the search_tools index; past it the description lists per-server counts only. */
export const MCP_ROUTER_INDEX_MAX_NAMES = 200;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A server's listing error, trimmed to its first line and 120 chars, for a short reply. */
function listingError(error?: string): string {
  const first = (error ?? "it didn't answer").split("\n")[0]!.trim();
  return first.length > 120 ? first.slice(0, 120) : first;
}

/**
 * The compact, deterministic MCP index for search_tools' description: one line
 * per server in name order. A listed server shows its tool count, and its
 * sorted tool names unless the names across all servers exceed
 * MCP_ROUTER_INDEX_MAX_NAMES; a null tools means no cached listing yet.
 */
export function routerIndex(servers: { name: string; tools: string[] | null }[]): string {
  if (!servers.length) return "";
  const ordered = [...servers].sort((a, b) => compare(a.name, b.name));
  const total = ordered.reduce((sum, s) => sum + (s.tools?.length ?? 0), 0);
  const lines = ordered.map((s) =>
    s.tools === null
      ? `- ${s.name} (not listed yet)`
      : total > MCP_ROUTER_INDEX_MAX_NAMES
        ? `- ${s.name} (${s.tools.length} tools)`
        : `- ${s.name} (${s.tools.length} tools): ${[...s.tools].sort(compare).join(", ")}`,
  );
  return `MCP servers and their tools (names only; fetch schemas with this tool):\n${lines.join("\n")}`;
}

/**
 * Rank a server's tools against a query: an exact tool name (in any of the
 * forms an agent writes it) wins outright, otherwise BM25 over the name (which
 * is boosted), the server and the description.
 */
export function rankTools(entries: { server: string; tool: McpToolInfo }[], query: string, limit: number): { server: string; tool: McpToolInfo; score: number }[] {
  const q = query.trim().toLowerCase();
  const exact = (e: { server: string; tool: McpToolInfo }): boolean =>
    [e.tool.name, `${e.server}.${e.tool.name}`, `${e.server}__${e.tool.name}`, `mcp__${e.server}__${e.tool.name}`].some((f) => f.toLowerCase() === q);
  const tiebreak = (a: { server: string; tool: McpToolInfo }, b: { server: string; tool: McpToolInfo }): number => compare(a.server, b.server) || compare(a.tool.name, b.tool.name);
  return bm25Rank(entries, (e) => `${e.tool.name} ${e.tool.name} ${e.server} ${e.tool.description}`, query, entries.length, tiebreak)
    .map((r) => (exact(r.item) ? { ...r, score: Infinity } : r))
    .sort((a, b) => b.score - a.score || tiebreak(a.item, b.item))
    .slice(0, limit)
    .map((r) => ({ server: r.item.server, tool: r.item.tool, score: r.score }));
}

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

const jsonValidator = new AjvJsonSchemaValidator();

/**
 * The two router tools: `search_tools` lists matching schemas, `call_mcp_tool`
 * runs one by server and tool name. Wiring them into a driver is a later step.
 * `projectId` names the project a tool-server session is bound to: its enabled
 * servers (and, from the cache only, their tool names) go into the descriptions
 * so the model knows what exists without a round-trip.
 */
/** How long a router call waits for a server to list its tools; `npx -y …` servers can take several seconds to start. */
const LIST_TIMEOUT_MS = 15_000;

export function routerTools(
  deps: {
    servers: (projectId: string | undefined) => McpServerEntry[];
    listings: Pick<McpToolsCache, "refresh" | "peek"> & Partial<Pick<McpToolsCache, "peekStale">>;
    pool: Pick<McpClientPool, "callTool">;
  },
  projectId?: string,
): HarnessTool[] {
  // Snapshot the cache synchronously: tools/list runs on every session open, so
  // refreshing here would list every server before a turn even starts. The
  // stale fallback is the previous session's listing, so a cold start still
  // shows the index.
  const enabled = deps.servers(projectId).filter((s) => s.enabled === true);
  const index = enabled.map((s) => {
    const listing = deps.listings.peek(s.spec);
    const tools = listing?.ok ? listing.tools : deps.listings.peekStale?.(s.spec)?.tools;
    return { name: s.name, tools: tools ? tools.map((t) => t.name) : null };
  });
  const searchDescription =
    "Search the MCP tools available in this project and get their input schemas. Call this before call_mcp_tool; pass an exact tool name to fetch that tool." +
    (index.some((s) => s.tools !== null) ? `\n\n${routerIndex(index)}` : "");
  const callDescription =
    "Call one MCP tool found with search_tools, by server and tool name, with arguments matching its inputSchema." +
    (enabled.length ? ` Servers: ${enabled.map((s) => s.name).sort(compare).join(", ")}.` : "");

  const search = define({
    name: "search_tools",
    description: searchDescription,
    autoAllow: true,
    input: {
      query: z.string().describe("What the tool should do, or its exact name"),
      limit: z.number().int().min(1).max(10).optional().describe("How many results (default 5)"),
    },
    effect: "read",
    run: async ({ query, limit }, ctx) => {
      const enabled = deps.servers(ctx?.projectId).filter((s) => s.enabled === true);
      await deps.listings.refresh(enabled, LIST_TIMEOUT_MS);
      const entries: { server: string; tool: McpToolInfo }[] = [];
      const unreachable: { name: string; error: string }[] = [];
      for (const server of enabled) {
        const listing = deps.listings.peek(server.spec);
        // A server that failed to list is unreachable, not a server with no matching tool.
        if (listing?.ok) for (const tool of listing.tools) entries.push({ server: server.name, tool });
        else unreachable.push({ name: server.name, error: listingError(listing?.error) });
      }
      if (!enabled.length) return { text: "No MCP servers are enabled for this project.", isError: true };
      const reached = (s: { name: string }) => !unreachable.some((u) => u.name === s.name);
      const ranked = rankTools(entries, query, limit ?? 5);
      if (!ranked.length) {
        if (unreachable.length === enabled.length) {
          return { text: `Couldn't reach any MCP server: ${unreachable.map((u) => `${u.name} (${u.error})`).join(", ")}`, isError: true };
        }
        if (unreachable.length) {
          const names = enabled.filter(reached).map((s) => s.name);
          return { text: `No tool matched "${query}" on ${names.join(", ")}. Couldn't reach: ${unreachable.map((u) => `${u.name} (${u.error})`).join(", ")}.` };
        }
        return { text: `No tool matched "${query}". Servers: ${enabled.map((s) => s.name).join(", ")}. Try other words or an exact tool name.` };
      }
      const out = ranked.map((r) => ({ server: r.server, tool: r.tool.name, description: r.tool.description, inputSchema: r.tool.inputSchema }));
      const missed = unreachable.length ? `\nCouldn't reach: ${unreachable.map((u) => `${u.name} (${u.error})`).join(", ")}; their tools aren't included.` : "";
      return { text: JSON.stringify(out, null, 2) + missed };
    },
  });

  const call = define({
    name: "call_mcp_tool",
    description: callDescription,
    autoAllow: false,
    input: {
      server: z.string(),
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional().describe("Arguments matching the tool's inputSchema from search_tools"),
    },
    effect: "mutate",
    run: async ({ server, tool, arguments: rawArgs }, ctx) => {
      const enabled = deps.servers(ctx?.projectId).filter((s) => s.enabled === true);
      const target = enabled.find((s) => s.name === server);
      if (!target) {
        const names = enabled.map((s) => s.name);
        return { text: `Unknown MCP server "${server}". Available: ${names.length ? names.join(", ") : "none"}.`, isError: true };
      }
      await deps.listings.refresh([target], LIST_TIMEOUT_MS);
      const listing = deps.listings.peek(target.spec);
      // A server that didn't list isn't missing the tool: say what went wrong instead.
      if (listing && !listing.ok) return { text: `Couldn't reach MCP server "${server}": ${(listing.error ?? "it didn't answer").replace(/\.$/, "")}.`, isError: true };
      const tools = listing?.ok ? listing.tools : [];
      const found = tools.find((t) => t.name === tool);
      if (!found) {
        const closest = rankTools(tools.map((t) => ({ server, tool: t })), tool, 10).map((r) => r.tool.name);
        const hint = closest.length ? ` Closest: ${closest.join(", ")}.` : "";
        return { text: `Unknown tool "${tool}" on server "${server}".${hint}`, isError: true };
      }
      const args = rawArgs ?? {};
      if (found.inputSchema && typeof found.inputSchema === "object") {
        const validate = jsonValidator.getValidator<Record<string, unknown>>(found.inputSchema as JsonSchemaType);
        const check = validate(args);
        if (!check.valid) {
          return { text: JSON.stringify({ status: "validation_error", server, tool, error: check.errorMessage, expected: found.inputSchema }), isError: true };
        }
      }
      const r = await deps.pool.callTool(target.spec, tool, args);
      return { text: r.text, isError: r.isError };
    },
  });

  return [search, call];
}
