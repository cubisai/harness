// Bundled connectors always execute in main, including stdio. Agents get only an opaque,
// thread-bound loopback route; an old route never resolves a replacement contribution.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerEntry, McpServerSpec, McpServerStatus, PermissionMode } from "../../shared/types";
import { stableStringify } from "../cache-policy";
import { gatewayPath } from "../mcp/gateway";
import { HEARTBEAT_MS } from "../mcp-http";
import { callServerTool, McpClientPool } from "../mcp/router";
import type { McpToolInfo } from "../mcp/servers";
import type { PluginBundles } from "./bundles";
import { connectorCallPermission, type NativeConnectorPermission } from "./tool-rules";

export type OwnedConnector = ReturnType<PluginBundles["connectors"]>[number];
interface ConnectorThread { projectId?: string; permissionMode: PermissionMode; design: boolean; signal?: AbortSignal }
interface Route { part: OwnedConnector; threadId?: string; projectId?: string }
interface Runtime {
  part: OwnedConnector;
  spec: McpServerSpec;
  pool: McpClientPool;
  stop: AbortController;
  tools?: McpToolInfo[];
  listing?: Promise<void>;
  listedAt?: number;
  schemaRevision: number;
}
export interface PluginConnectorsDeps {
  bundles: Pick<PluginBundles, "connectors" | "assertConnector" | "rules" | "rulesRevision">;
  endpoint(): { url: string; token: string } | null;
  resolve(part: OwnedConnector): McpServerSpec;
  pool?(part: OwnedConnector, spec: McpServerSpec, changed: () => void): McpClientPool;
  thread(id: string): ConnectorThread | null;
  approve(threadId: string, server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal, gate?: { forced: boolean; identity: string }): Promise<boolean>;
  nativeAsk?(threadId: string, server: string, tool: string, args: Record<string, unknown>): boolean | NativeConnectorPermission;
  changed?(): void;
  now?(): number;
}
interface CallOptions {
  threadId?: string;
  signal?: AbortSignal;
  /** Main-only app/card grant and single-use approval gate. Never supplied in MCP arguments. */
  before?: (found: McpToolInfo, identity?: string) => Promise<string | null>;
}
type Reply = { text: string; isError: boolean; data?: unknown; readOnly?: true };
const failed = (e: unknown): Reply => ({ text: e instanceof Error ? e.message : String(e), isError: true });
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("This plugin connector call stopped."));
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(new Error("This plugin connector call stopped."));
    signal.addEventListener("abort", stop, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener("abort", stop));
}

export class PluginConnectors {
  private routes = new Map<string, Route>();
  private threads = new Map<string, string[]>();
  private listings = new Map<string, string>();
  private runtimes = new Map<string, Runtime>();
  private active = new Map<string, Set<AbortController>>();
  private threadCalls = new Map<string, Set<AbortController>>();

  constructor(private deps: PluginConnectorsDeps) {}

  /** Library inspection is local. Only the explicit Check action connects/lists. */
  peek(part: OwnedConnector): McpServerStatus {
    const runtime = this.runtimes.get(part.runtimeName);
    return runtime?.part.revision === part.revision && runtime.tools
      ? { name: part.runtimeName, state: "connected", tools: runtime.tools.map(({ name, description }) => ({ name, description })) }
      : { name: part.runtimeName, state: "checking", tools: [] };
  }

  async check(part: OwnedConnector): Promise<McpServerStatus> {
    const runtime = this.runtime(part); await this.refresh(runtime);
    this.deps.bundles.assertConnector(part); return this.peek(part);
  }

  has(name: string, threadId?: string): boolean {
    // A removed contribution remains reserved in its old thread's snapshot. Never fall
    // through to a later standalone server that happens to reuse the runtime name.
    return this.deps.bundles.connectors(true).some((c) => c.runtimeName === name)
      || Boolean(threadId && (this.threads.get(threadId) ?? []).some((id) => this.routes.get(id)?.part.runtimeName === name));
  }

  /** Building a descriptor never starts a process, probes a server or signs in. */
  entries(threadId?: string): McpServerEntry[] {
    const endpoint = this.deps.endpoint();
    if (!endpoint) return [];
    let ids: string[];
    if (threadId) {
      const thread = this.deps.thread(threadId);
      if (!thread) return [];
      ids = this.threads.get(threadId) ?? this.deps.bundles.connectors().map((part) => this.route({ part, threadId, projectId: thread.projectId }));
      this.threads.set(threadId, ids);
    } else {
      // Main's Context/Library listing routes can list, but can never execute a tool.
      ids = this.deps.bundles.connectors().map((part) => {
        const key = `${part.owner.key}\0${part.runtimeName}\0${part.revision}`;
        let id = this.listings.get(key);
        if (!id) { id = this.route({ part }); this.listings.set(key, id); }
        return id;
      });
    }
    return ids.flatMap((id) => {
      const route = this.routes.get(id);
      if (!route || !this.valid(route)) return [];
      return [{ name: route.part.runtimeName, enabled: true, mainMediated: true as const, spec: { type: "http" as const, url: new URL(gatewayPath("plugin", id), endpoint.url).toString(), headers: { Authorization: `Bearer ${endpoint.token}` } } }];
    });
  }

  private route(route: Route): string {
    const id = randomBytes(24).toString("hex"); this.routes.set(id, route); return id;
  }
  private valid(route: Route): boolean {
    try {
      this.deps.bundles.assertConnector(route.part);
      if (!route.threadId) return true;
      const thread = this.deps.thread(route.threadId);
      return Boolean(thread && thread.projectId === route.projectId);
    } catch { return false; }
  }
  private assertRoute(route: Route): void {
    this.deps.bundles.assertConnector(route.part);
    if (route.threadId) {
      const thread = this.deps.thread(route.threadId);
      if (!thread || thread.projectId !== route.projectId) throw new Error("This connector's originating thread or project changed.");
    }
  }
  private runtime(part: OwnedConnector): Runtime {
    this.deps.bundles.assertConnector(part);
    const spec = this.deps.resolve(part), key = part.runtimeName;
    let runtime = this.runtimes.get(key);
    if (runtime && (runtime.part.revision !== part.revision || stableStringify(runtime.spec) !== stableStringify(spec))) {
      this.drop(runtime); runtime = undefined;
    }
    if (!runtime) {
      const changed = () => {
        if (this.runtimes.get(key) !== runtime) return;
        runtime!.tools = undefined; runtime!.schemaRevision++; this.deps.changed?.();
      };
      runtime = { part, spec, stop: new AbortController(), schemaRevision: 0, pool: this.deps.pool?.(part, spec, changed) ?? new McpClientPool({ onToolsChanged: changed }) };
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }
  private async refresh(runtime: Runtime): Promise<void> {
    const now = this.deps.now ?? Date.now;
    // A pooled connection can idle out and reconnect without a notification. Do not
    // keep an old read-only classification forever after the server changes.
    if (runtime.tools && now() - (runtime.listedAt ?? 0) < 600_000) return;
    const revision = runtime.schemaRevision;
    runtime.listing ??= runtime.pool.listTools(runtime.spec, runtime.stop.signal).then((result) => {
      if (!result.ok) throw new Error(result.error ?? "The plugin connector didn't answer.");
      if (runtime.stop.signal.aborted) throw new Error("This plugin connector stopped.");
      this.deps.bundles.assertConnector(runtime.part);
      if (revision !== runtime.schemaRevision) throw new Error("The connector's tools changed while listing; retry the call.");
      runtime.tools = result.tools;
      runtime.listedAt = now();
    }).finally(() => { runtime.listing = undefined; });
    await runtime.listing;
  }

  async call(projectId: string | undefined, server: string, tool: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<Reply> {
    const route = opts.threadId
      ? (this.threads.get(opts.threadId) ?? []).map((id) => this.routes.get(id)).find((r) => r?.part.runtimeName === server)
      : this.deps.bundles.connectors().map((part): Route => ({ part, projectId })).find((r) => r.part.runtimeName === server);
    if (!route || route.projectId !== projectId) return failed("This plugin connector isn't available in the originating thread/project. Start a new thread.");
    return this.invoke(route, tool, args, opts);
  }

  private async invoke(route: Route, tool: string, args: Record<string, unknown>, opts: CallOptions): Promise<Reply> {
    const controller = new AbortController(), owner = route.part.owner.key;
    const active = this.active.get(owner) ?? new Set<AbortController>(); active.add(controller); this.active.set(owner, active);
    const threadCalls = route.threadId ? this.threadCalls.get(route.threadId) ?? new Set<AbortController>() : null;
    if (route.threadId && threadCalls) { threadCalls.add(controller); this.threadCalls.set(route.threadId, threadCalls); }
    try {
      const input = JSON.parse(stableStringify(args)) as Record<string, unknown>, pinned = stableStringify(input);
      this.assertRoute(route);
      const thread = route.threadId ? this.deps.thread(route.threadId) : null;
      if (!opts.before && (!route.threadId || !thread?.signal || thread.signal.aborted)) return failed("This connector call needs its originating active turn.");
      const signals = [controller.signal, ...(opts.signal ? [opts.signal] : []), ...(thread?.signal ? [thread.signal] : [])];
      const signal = AbortSignal.any(signals);
      const policy = this.deps.bundles.rulesRevision();
      const runtime = this.runtime(route.part);
      let validatedSchema: number | undefined;
      const assert = () => {
        if (signal.aborted) throw new Error("This plugin connector call stopped.");
        this.assertRoute(route);
        if (this.deps.bundles.rulesRevision() !== policy) throw new Error("Plugin rules changed; retry the call.");
        if (stableStringify(input) !== pinned) throw new Error("The approved connector input changed; retry the call.");
        if (validatedSchema !== undefined && validatedSchema !== runtime.schemaRevision) throw new Error("The connector's tool list changed; retry the call.");
        if (route.threadId) {
          const now = this.deps.thread(route.threadId);
          if (!now || now.permissionMode !== thread?.permissionMode || now.design !== thread?.design || now.signal !== thread?.signal) throw new Error("The originating turn or permissions changed; retry the call.");
        }
      };
      assert();
      const listings = { refresh: async () => { await abortable(this.refresh(runtime), signal); validatedSchema = runtime.schemaRevision; assert(); }, peek: () => ({ ok: true, tools: runtime.tools ?? [] }) };
      const result = await callServerTool({ servers: () => [{ name: route.part.runtimeName, enabled: true, spec: runtime.spec }], listings, pool: runtime.pool }, route.projectId, route.part.runtimeName, tool, input, signal, async (found) => {
        assert();
        const identity = createHash("sha256").update(stableStringify({ owner: route.part.owner.key, revision: route.part.revision, spec: runtime.spec, found })).digest("hex");
        if (thread && (thread.permissionMode === "plan" || thread.design) && !found.readOnly) return "Plan/design mode cannot change connector data.";
        if (opts.before) {
          const denied = await abortable(opts.before(found, identity), signal);
          if (denied) return denied;
        } else {
          const native = this.deps.nativeAsk?.(route.threadId!, route.part.runtimeName, tool, input) ?? false;
          const decision = this.deps.bundles.rules({ kind: "connector", server: route.part.runtimeName, tool }, found.readOnly === true);
          const { ask, forced } = connectorCallPermission(decision, found.readOnly === true, thread?.permissionMode ?? "ask", native);
          if (ask) {
            if (!await abortable(this.deps.approve(route.threadId!, route.part.runtimeName, tool, JSON.parse(pinned), signal, { forced, identity }), signal)) return "The user denied this connector call.";
          }
        }
        assert(); return null;
      });
      assert(); return result;
    } catch (e) { return failed(e); }
    finally {
      active.delete(controller); if (!active.size) this.active.delete(owner);
      if (route.threadId && threadCalls) { threadCalls.delete(controller); if (!threadCalls.size) this.threadCalls.delete(route.threadId); }
    }
  }

  /** Already behind the tool-server Bearer; the opaque route binds identity in main, never in arguments/query. */
  async handle(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const route = this.routes.get(id);
    if (!route || !this.valid(route)) { res.writeHead(404).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.writeHead(400).end(); return; }
    const gone = new AbortController();
    const server = new Server({ name: route.part.runtimeName, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.assertRoute(route);
      const runtime = this.runtime(route.part); await abortable(this.refresh(runtime), gone.signal);
      this.assertRoute(route);
      return { tools: (runtime.tools ?? []).map(({ readOnly, ...t }) => ({ ...t, inputSchema: { ...(t.inputSchema as { type: "object" }), required: (t.inputSchema as { required?: string[] }).required ?? [] }, ...(readOnly ? { annotations: { readOnlyHint: true } } : {}) })) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      let progress = 0;
      const token = extra._meta?.progressToken;
      const timer = token === undefined ? undefined : setInterval(() => { void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++progress } }).catch(() => {}); }, HEARTBEAT_MS);
      try {
        const result = await this.invoke(route, request.params.name, request.params.arguments ?? {}, { signal: AbortSignal.any([gone.signal, extra.signal]) });
        return { content: [{ type: "text" as const, text: result.text }], isError: result.isError, ...(result.data && typeof result.data === "object" ? { structuredContent: result.data as Record<string, unknown> } : {}) };
      } finally { clearInterval(timer); }
    });
    // Stream approvals, with the same heartbeat convention as the app's other waiting MCP tools.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
    res.on("close", () => { if (!res.writableFinished) gone.abort(); void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, body); }
    catch { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); }
  }

  invalidate(owner: string): void {
    for (const controller of this.active.get(owner) ?? []) controller.abort();
    for (const runtime of this.runtimes.values()) if (runtime.part.owner.key === owner) this.drop(runtime);
    for (const [key, id] of this.listings) if (key.startsWith(`${owner}\0`)) { this.routes.delete(id); this.listings.delete(key); }
  }
  invalidateRules(): void { for (const active of this.active.values()) for (const controller of active) controller.abort(); }
  forgetThread(threadId: string): void {
    for (const controller of this.threadCalls.get(threadId) ?? []) controller.abort();
    for (const id of this.threads.get(threadId) ?? []) this.routes.delete(id);
    this.threads.delete(threadId);
  }
  private drop(runtime: Runtime): void {
    runtime.stop.abort();
    if (this.runtimes.get(runtime.part.runtimeName) === runtime) this.runtimes.delete(runtime.part.runtimeName);
    void runtime.pool.closeAll().catch(() => {});
  }
  async closeAll(): Promise<void> {
    this.invalidateRules();
    const runtimes = [...this.runtimes.values()]; this.runtimes.clear();
    for (const runtime of runtimes) runtime.stop.abort();
    await Promise.all(runtimes.map((runtime) => runtime.pool.closeAll()));
    this.routes.clear(); this.threads.clear(); this.listings.clear();
  }
}
