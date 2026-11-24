// Every external connector, including stdio, is executed in main. Native engines
// receive an opaque, scoped snapshot, not credentials or a process command.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema, CallToolResultSchema, GetPromptRequestSchema, GetPromptResultSchema,
  ListPromptsRequestSchema, ListPromptsResultSchema, ListResourcesRequestSchema, ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema, ListResourceTemplatesResultSchema, ListToolsRequestSchema,
  ReadResourceRequestSchema, ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import type { z } from "zod";
import type { McpServerEntry, McpServerSpec, PermissionMode } from "../../shared/types";
import type { PluginBundles } from "../apps/bundles";
import { connectorCallPermission, type NativeConnectorPermission } from "../apps/tool-rules";
import { stableStringify } from "../cache-policy";
import { HEARTBEAT_MS } from "../mcp-http";
import { gatewayPath } from "./gateway";
import { McpClientPool } from "./router";
import type { McpToolInfo } from "./servers";

interface ManagedConnectorThread { projectId?: string; permissionMode: PermissionMode; kind: string; agent: string; signal?: AbortSignal }
interface Snapshot { scope: string; name: string; hash: string; epoch: number; projectEpoch?: number; projectId?: string; threadId?: string }
interface Runtime { snapshot: Snapshot; spec: McpServerSpec; pool: McpClientPool; stop: AbortController; tools?: McpToolInfo[]; listedAt?: number; listing?: Promise<void>; revision: number }
export interface ManagedConnectorsDeps {
  configured(projectId: string | null): { scope: string; entry: McpServerEntry }[];
  endpoint(): { url: string; token: string } | null;
  resolve(entry: McpServerEntry): McpServerSpec;
  pool(scope: string, name: string, changed: () => void): McpClientPool;
  policy: Pick<PluginBundles, "rules" | "rulesRevision">;
  thread(id: string): ManagedConnectorThread | null;
  approve(threadId: string, server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal, gate?: { forced: boolean; identity: string }): Promise<boolean>;
  nativeAsk?(threadId: string, server: string, tool: string, args: Record<string, unknown>): boolean | NativeConnectorPermission;
  changed?(): void;
  now?(): number;
}
interface CallOptions {
  threadId?: string;
  signal?: AbortSignal;
  /** Main-only app/card or routed permission gate. It retains the existing grants,
   * forced Ask and single-use approvals; never accepted from MCP arguments. */
  before?: (found: McpToolInfo, identity?: string) => Promise<string | null>;
}
const hash = (spec: McpServerSpec) => createHash("sha256").update(stableStringify(spec)).digest("hex");
const keyOf = (s: Snapshot) => `${s.scope}\0${s.name}`;
const failed = (e: unknown) => ({ content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true });
const validator = new AjvJsonSchemaValidator();
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { work.catch(() => {}); return Promise.reject(new Error("This connector call stopped.")); }
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => { stop = () => reject(new Error("This connector call stopped.")); signal.addEventListener("abort", stop, { once: true }); });
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener("abort", stop));
}

export class ManagedConnectors {
  private routes = new Map<string, Snapshot>();
  private routeIds = new Map<string, string>();
  private threads = new Map<string, string[]>();
  private epochs = new Map<string, number>();
  private projectEpochs = new Map<string, number>();
  private runtimes = new Map<string, Runtime>();
  private active = new Map<AbortController, Snapshot>();
  private threadCalls = new Map<string, Set<AbortController>>();
  private disposed = false;

  constructor(private deps: ManagedConnectorsDeps) {}

  /** Descriptor creation is entirely local: no connect, process or sign-in. */
  entries(projectId: string | null, threadId?: string): McpServerEntry[] {
    const endpoint = this.deps.endpoint();
    if (!endpoint || this.disposed) return [];
    const pid = projectId ?? undefined;
    if (threadId && this.deps.thread(threadId)?.projectId !== pid) return [];
    const ids = this.deps.configured(projectId).filter(({ entry }) => !entry.locked).map(({ scope, entry }) => {
      const snapshot: Snapshot = { scope, name: entry.name, hash: hash(entry.spec), epoch: this.epochs.get(`${scope}\0${entry.name}`) ?? 0, projectEpoch: this.projectEpochs.get(`${pid ?? ""}\0${entry.name}`) ?? 0, projectId: pid, threadId };
      const key = stableStringify(snapshot);
      let id = this.routeIds.get(key);
      if (!id) { id = randomBytes(24).toString("hex"); this.routeIds.set(key, id); this.routes.set(id, snapshot); }
      return id;
    });
    if (threadId) this.threads.set(threadId, ids);
    return ids.map((id) => ({ name: this.routes.get(id)!.name, enabled: true, mainMediated: true, spec: { type: "http", url: new URL(gatewayPath("managed", id), endpoint.url).toString(), headers: { Authorization: `Bearer ${endpoint.token}` } } }));
  }

  private entry(snapshot: Snapshot): McpServerEntry {
    if (this.disposed || (this.epochs.get(keyOf(snapshot)) ?? 0) !== snapshot.epoch) throw new Error("This connector session changed. Start a new mediated session.");
    if (snapshot.projectEpoch !== undefined && (this.projectEpochs.get(`${snapshot.projectId ?? ""}\0${snapshot.name}`) ?? 0) !== snapshot.projectEpoch) throw new Error("This project's connector availability changed. Start a new mediated session.");
    if (snapshot.threadId) {
      const thread = this.deps.thread(snapshot.threadId);
      if (!thread || thread.projectId !== snapshot.projectId) throw new Error("This connector belongs to another originating thread/project.");
    }
    const found = this.deps.configured(snapshot.projectId ?? null).find(({ entry }) => entry.name === snapshot.name);
    if (!found || found.scope !== snapshot.scope || found.entry.locked || hash(found.entry.spec) !== snapshot.hash) throw new Error("This connector was disabled, removed or replaced. Start a new mediated session.");
    return found.entry;
  }

  private runtime(snapshot: Snapshot): Runtime {
    const spec = this.deps.resolve(this.entry(snapshot)), key = keyOf(snapshot);
    let runtime = this.runtimes.get(key);
    if (runtime && (runtime.snapshot.hash !== snapshot.hash || runtime.snapshot.epoch !== snapshot.epoch || stableStringify(runtime.spec) !== stableStringify(spec))) { this.drop(runtime); runtime = undefined; }
    if (!runtime) {
      const changed = () => { if (this.runtimes.get(key) !== runtime) return; runtime!.tools = undefined; runtime!.revision++; this.deps.changed?.(); };
      // A shared runtime belongs to its configured scope, not whichever thread
      // happened to list first. Per-request origin checks stay on the route.
      const runtimeSnapshot = { ...snapshot, threadId: undefined, projectEpoch: undefined, projectId: snapshot.scope.startsWith("project:") ? snapshot.scope.slice(8) : undefined };
      runtime = { snapshot: runtimeSnapshot, spec, stop: new AbortController(), revision: 0, pool: this.deps.pool(snapshot.scope, snapshot.name, changed) };
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  private async refresh(runtime: Runtime): Promise<void> {
    const now = this.deps.now ?? Date.now;
    if (runtime.tools && now() - (runtime.listedAt ?? 0) < 600_000) return;
    const revision = runtime.revision;
    runtime.listing ??= runtime.pool.listTools(runtime.spec, runtime.stop.signal).then((r) => {
      if (!r.ok) throw new Error(r.error ?? "The connector didn't answer.");
      if (runtime.stop.signal.aborted || revision !== runtime.revision) throw new Error("The connector's tool list changed; retry the call.");
      this.entry(runtime.snapshot); runtime.tools = r.tools; runtime.listedAt = now();
    }).finally(() => { runtime.listing = undefined; });
    await runtime.listing;
  }

  private async invoke(snapshot: Snapshot, tool: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<z.output<typeof CallToolResultSchema>> {
    const controller = new AbortController(); this.active.set(controller, snapshot);
    const calls = snapshot.threadId ? this.threadCalls.get(snapshot.threadId) ?? new Set<AbortController>() : null;
    if (snapshot.threadId && calls) { calls.add(controller); this.threadCalls.set(snapshot.threadId, calls); }
    try {
      this.entry(snapshot);
      const thread = snapshot.threadId ? this.deps.thread(snapshot.threadId) : null;
      if (!opts.before && (!snapshot.threadId || !thread?.signal || thread.signal.aborted)) return failed("This connector call needs its originating active turn.");
      const runtime = this.runtime(snapshot);
      const signal = AbortSignal.any([controller.signal, runtime.stop.signal, ...(opts.signal ? [opts.signal] : []), ...(thread?.signal ? [thread.signal] : [])]);
      const policy = this.deps.policy.rulesRevision();
      const input = JSON.parse(stableStringify(args)) as Record<string, unknown>, pinned = stableStringify(input);
      let revision: number | undefined;
      const assert = () => {
        if (signal.aborted) throw new Error("This connector call stopped.");
        this.entry(snapshot);
        if (policy !== this.deps.policy.rulesRevision()) throw new Error("Plugin rules changed; retry the call.");
        if (snapshot.threadId) {
          const now = this.deps.thread(snapshot.threadId);
          if (!now || now.signal !== thread?.signal || now.permissionMode !== thread?.permissionMode || now.kind !== thread?.kind || now.agent !== thread?.agent) throw new Error("The originating turn or permissions changed; retry the call.");
        }
        if (stableStringify(input) !== pinned) throw new Error("The approved connector input changed; retry the call.");
        if (revision !== undefined && revision !== runtime.revision) throw new Error("The connector's tool list changed; retry the call.");
      };
      assert(); await abortable(this.refresh(runtime), signal); assert();
      revision = runtime.revision;
      const found = runtime.tools?.find((t) => t.name === tool);
      if (!found) return failed(`Unknown tool "${tool}" on connector "${snapshot.name}".`);
      const check = validator.getValidator<Record<string, unknown>>(found.inputSchema as JsonSchemaType)(input);
      if (!check.valid) return failed(`Invalid connector input: ${check.errorMessage}`);
      const identity = createHash("sha256").update(stableStringify({ scope: snapshot.scope, epoch: snapshot.epoch, projectEpoch: snapshot.projectEpoch, spec: runtime.spec, found })).digest("hex");
      if (thread && (thread.permissionMode === "plan" || thread.kind === "design") && !found.readOnly) return failed("Plan/design mode cannot change connector data.");
      if (opts.before) {
        const denied = await abortable(opts.before(found, identity), signal);
        if (denied) return failed(denied);
      } else {
        const native = this.deps.nativeAsk?.(snapshot.threadId!, snapshot.name, tool, input) ?? false;
        const decision = this.deps.policy.rules({ kind: "connector", server: snapshot.name, tool }, found.readOnly === true);
        const { ask, forced } = connectorCallPermission(decision, found.readOnly === true, thread?.permissionMode ?? "ask", native);
        if (ask) {
          // The approval receives its own copy; neither it nor model arguments
          // can replace the pinned input which will actually execute.
          if (!await abortable(this.deps.approve(snapshot.threadId!, snapshot.name, tool, JSON.parse(pinned), signal, { forced, identity }), signal)) return failed("The user denied this connector call.");
        }
      }
      assert();
      if (revision !== runtime.revision) return failed("The connector's tool list changed while waiting; retry the call.");
      const result = await abortable(runtime.pool.request(runtime.spec, "tools/call", { name: tool, arguments: input }, CallToolResultSchema, signal), signal);
      assert(); return result;
    } catch (e) { return failed(e); }
    finally { this.active.delete(controller); if (snapshot.threadId && calls) { calls.delete(controller); if (!calls.size) this.threadCalls.delete(snapshot.threadId); } }
  }

  async call(projectId: string | undefined, server: string, tool: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<{ text: string; isError: boolean; data?: unknown; readOnly?: true }> {
    if (opts.threadId && !this.threads.has(opts.threadId)) this.entries(projectId ?? null, opts.threadId);
    const snapshot = opts.threadId
      ? (this.threads.get(opts.threadId) ?? []).map((id) => this.routes.get(id)).find((s) => s?.name === server)
      : this.deps.configured(projectId ?? null).map(({ scope, entry }): Snapshot => ({ scope, name: entry.name, hash: hash(entry.spec), epoch: this.epochs.get(`${scope}\0${entry.name}`) ?? 0, projectEpoch: this.projectEpochs.get(`${projectId ?? ""}\0${entry.name}`) ?? 0, projectId })).find((s) => s.name === server);
    if (!snapshot || snapshot.projectId !== projectId) return { text: "This connector isn't available in the originating thread/project.", isError: true };
    const r = await this.invoke(snapshot, tool, args, opts);
    const data = r.structuredContent;
    const text = (r.content ?? []).map((c) => c.type === "text" ? c.text : c.type === "resource" ? ("text" in c.resource ? c.resource.text : c.resource.uri) : c.type === "resource_link" ? c.uri : `[${c.type} content omitted]`).join("\n");
    const readOnly = this.runtimes.get(keyOf(snapshot))?.tools?.find((t) => t.name === tool)?.readOnly;
    return { text: text.trim() || (data !== undefined ? JSON.stringify(data) : ""), isError: r.isError === true, ...(data !== undefined ? { data } : {}), ...(readOnly ? { readOnly: true } : {}) };
  }

  async handle(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const snapshot = this.routes.get(id);
    try { if (!snapshot) throw new Error("Unknown route"); this.entry(snapshot); }
    catch { res.writeHead(404).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of req) { size += (chunk as Buffer).length; if (size > 16 * 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk as Buffer); }
    } catch { if (!res.destroyed) res.writeHead(400).end(); return; }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400).end(); return; }
    const gone = new AbortController();
    const server = new Server({ name: snapshot.name, version: "1.0.0" }, { capabilities: { tools: {}, prompts: {}, resources: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const runtime = this.runtime(snapshot); await abortable(this.refresh(runtime), gone.signal); this.entry(snapshot);
      return { tools: (runtime.tools ?? []).map(({ readOnly, ...t }) => ({ ...t, inputSchema: t.inputSchema as { type: "object" }, ...(readOnly ? { annotations: { readOnlyHint: true } } : {}) })) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const token = extra._meta?.progressToken; let progress = 0;
      const timer = token === undefined ? undefined : setInterval(() => { void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++progress } }).catch(() => {}); }, HEARTBEAT_MS);
      try { return await this.invoke(snapshot, request.params.name, request.params.arguments ?? {}, { signal: AbortSignal.any([gone.signal, extra.signal]) }); }
      finally { clearInterval(timer); }
    });
    const forward = <S extends z.ZodTypeAny>(method: string, schema: S) => async (r: { params?: unknown }, extra: { signal: AbortSignal }) => {
      const runtime = this.runtime(snapshot), signal = AbortSignal.any([gone.signal, extra.signal, runtime.stop.signal]);
      const result = await abortable(runtime.pool.request(runtime.spec, method, r.params as Record<string, unknown> | undefined, schema, signal), signal);
      this.entry(snapshot); return result;
    };
    server.setRequestHandler(ListPromptsRequestSchema, forward("prompts/list", ListPromptsResultSchema));
    server.setRequestHandler(GetPromptRequestSchema, forward("prompts/get", GetPromptResultSchema));
    server.setRequestHandler(ListResourcesRequestSchema, forward("resources/list", ListResourcesResultSchema));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, forward("resources/templates/list", ListResourceTemplatesResultSchema));
    server.setRequestHandler(ReadResourceRequestSchema, forward("resources/read", ReadResourceResultSchema));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
    res.on("close", () => { if (!res.writableFinished) gone.abort(); void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, body); }
    catch { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); }
  }

  invalidate(scope: string, name: string): void {
    const key = `${scope}\0${name}`; this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    for (const [controller, snapshot] of this.active) if (keyOf(snapshot) === key) controller.abort();
    const runtime = this.runtimes.get(key); if (runtime) this.drop(runtime);
    for (const [id, snapshot] of this.routes) if (keyOf(snapshot) === key) { this.routes.delete(id); this.routeIds.delete(stableStringify(snapshot)); }
    this.deps.changed?.();
  }
  invalidateProject(projectId: string, name: string): void {
    const key = `${projectId}\0${name}`; this.projectEpochs.set(key, (this.projectEpochs.get(key) ?? 0) + 1);
    for (const [controller, snapshot] of this.active) if (snapshot.projectId === projectId && snapshot.name === name) controller.abort();
    for (const [id, snapshot] of this.routes) if (snapshot.projectId === projectId && snapshot.name === name) { this.routes.delete(id); this.routeIds.delete(stableStringify(snapshot)); }
    this.deps.changed?.();
  }
  invalidateRules(): void { for (const controller of this.active.keys()) controller.abort(); }
  forgetThread(threadId: string): void {
    for (const controller of this.threadCalls.get(threadId) ?? []) controller.abort();
    for (const [id, s] of this.routes) if (s.threadId === threadId) { this.routes.delete(id); this.routeIds.delete(stableStringify(s)); }
    this.threads.delete(threadId);
  }
  private drop(runtime: Runtime): void { runtime.stop.abort(); if (this.runtimes.get(keyOf(runtime.snapshot)) === runtime) this.runtimes.delete(keyOf(runtime.snapshot)); void runtime.pool.closeAll().catch(() => {}); }
  async closeAll(): Promise<void> {
    this.disposed = true; this.invalidateRules();
    const runtimes = [...this.runtimes.values()]; this.runtimes.clear(); for (const r of runtimes) r.stop.abort();
    await Promise.all(runtimes.map((r) => r.pool.closeAll())); this.routes.clear(); this.routeIds.clear(); this.threads.clear();
  }
}
