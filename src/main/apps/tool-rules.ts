// Native engines may never consult their permission callback (Full access, remembered
// approvals or bare allowedTools). Mandatory bundle rules therefore live inside run().
import { z } from "zod";
import { createHash } from "node:crypto";
import type { PermissionMode } from "../../shared/types";
import type { HarnessTool, ToolContext, ToolOutput } from "../agents/types";
import { stableStringify } from "../cache-policy";
import type { PluginBundles } from "./bundles";

export interface RuleThread {
  projectId: string;
  permissionMode: PermissionMode;
  kind: string;
  agent: string;
  signal?: AbortSignal;
}
export interface ManagedToolRulesDeps {
  policy: Pick<PluginBundles, "rules" | "rulesRevision">;
  thread(id: string): RuleThread | null;
  /** Single-use host approval: never consults or rewrites remembered approvals. */
  approve(threadId: string, name: string, summary: string, signal: AbortSignal): Promise<boolean>;
}
const error = (text: string): ToolOutput => ({ text, isError: true });
interface Deferral { thread: RuleThread & { signal: AbortSignal }; policy: string; args?: string; decision?: "ask" | "allow"; requireApproval?: true; normalApproval?: true }
interface DelegatedApproval { thread: RuleThread & { signal: AbortSignal }; policy: string; name: string; args: string }
const argsKey = (args: Record<string, unknown>) => createHash("sha256").update(stableStringify(args)).digest("hex");

/** Outer and inner exact policies describe one effective managed invocation. */
export function managedCallPermission(decisions: readonly ("ask" | "allow" | null)[], readOnly: boolean, deferred: boolean, mode: PermissionMode): { ask: boolean; forced: boolean } {
  const forced = decisions.includes("ask"), allowedRead = readOnly && decisions.includes("allow");
  return { forced, ask: forced || (deferred && !allowedRead && mode !== "full") };
}

export interface NativeConnectorPermission { ask: boolean; forced?: boolean }
/** Classification comes from the fresh main-side schema, not native display input. */
export function connectorCallPermission(decision: "ask" | "allow" | null, readOnly: boolean, mode: PermissionMode, native: boolean | NativeConnectorPermission = false) {
  const forced = decision === "ask" || native === true || (typeof native === "object" && native.forced === true);
  const ordinary = typeof native === "object" && native.ask;
  return { forced, ask: forced || (mode !== "full" && (!readOnly || (ordinary && decision !== "allow"))) };
}

function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { work.catch(() => {}); return Promise.reject(new Error("The managed tool call stopped.")); }
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(new Error("The managed tool call stopped."));
    signal.addEventListener("abort", stop, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener("abort", stop));
}

export class ManagedToolRules {
  private wrapped = new WeakMap<HarnessTool, Map<string, HarnessTool>>();
  private bindings = new Map<string, Set<Map<string, HarnessTool>>>();
  private active = new Set<AbortController>();
  private threads = new Map<string, Set<AbortController>>();
  private disposed = false;
  private deferrals = new Map<string, Deferral[]>();
  private nativeAsks = new Map<string, RuleThread & { signal: AbortSignal; forced: boolean }>();
  private origins = new WeakMap<HarnessTool, HarnessTool>();
  private delegated = new WeakMap<object, DelegatedApproval>();

  constructor(private deps: ManagedToolRulesDeps) {}

  tools(tools: HarnessTool[], threadId?: string): HarnessTool[] { return tools.map((tool) => this.tool(tool, threadId)); }

  /** Main-created per-invocation adapters need no retained descriptor/cache entry. */
  execute(tool: HarnessTool, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    return this.run(tool, ctx.threadId, args, ctx);
  }

  tool(tool: HarnessTool, threadId?: string): HarnessTool {
    // Plugin tools already have a stricter owner/queue/approval gate. Re-wrapping
    // them (or one of our own wrappers) would ask twice for the same invocation.
    if (tool.pluginRulesHandled) return tool;
    const key = threadId ?? "";
    const byThread = this.wrapped.get(tool) ?? new Map<string, HarnessTool>();
    this.wrapped.set(tool, byThread);
    let wrapped = byThread.get(key);
    if (!wrapped) {
      wrapped = { ...tool, pluginRulesHandled: true,
        deferPermission: (args, ctx) => {
          if (threadId && ctx.threadId !== threadId) return false;
          const parsed = args === undefined ? undefined : z.object(tool.input).strict().safeParse(args);
          if (parsed && !parsed.success) return false;
          const child = parsed ? this.child(tool, parsed.data) : undefined;
          const readOnly = child ? child.tool.effect === "read" : tool.effect === "read";
          const own = this.deps.policy.rules({ kind: "tool", name: tool.name }, readOnly);
          const inner = child ? this.deps.policy.rules({ kind: "tool", name: child.tool.name }, readOnly) : null;
          const decision = own === "ask" || inner === "ask" ? "ask" : own === "allow" || inner === "allow" ? "allow" : null;
          if (!decision && !ctx.requireApproval) return false;
          if (this.deps.thread(ctx.threadId ?? "")?.permissionMode === "plan" && !readOnly) return false;
          return this.deferCall(tool.name, parsed?.data, ctx, decision ?? undefined);
        },
        run: (args, ctx) => this.run(tool, threadId, args, ctx) };
      byThread.set(key, wrapped);
      this.origins.set(wrapped, tool);
      if (threadId) {
        const bindings = this.bindings.get(threadId) ?? new Set<Map<string, HarnessTool>>();
        bindings.add(byThread); this.bindings.set(threadId, bindings);
      }
    }
    return wrapped;
  }

  private child(tool: HarnessTool, args: Record<string, unknown>): { tool: HarnessTool; args: Record<string, unknown> } | undefined {
    const target = tool.approvalTarget?.(args), raw = target && this.origins.get(target.tool);
    // Only a wrapper owned by this authority can share an approval. Plugins,
    // arbitrary scripts and unwrapped tools retain their independent gates.
    return target && raw ? { tool: raw, args: target.args } : undefined;
  }

  private prune(threadId: string, turn: AbortSignal): void {
    for (const [key, tickets] of this.deferrals) if (key.startsWith(`${threadId}\0`)) {
      const live = tickets.filter((t) => t.thread.signal === turn);
      if (live.length) this.deferrals.set(key, live); else this.deferrals.delete(key);
    }
    for (const [key, origin] of this.nativeAsks) if (key.startsWith(`${threadId}\0`) && origin.signal !== turn) this.nativeAsks.delete(key);
  }

  /** A routing ticket is NOT a user approval. It pins an engine callback to the
   * host gate which will inspect/ask about the real input immediately before use. */
  deferCall(name: string, args: Record<string, unknown> | undefined, ctx: ToolContext, decision?: "ask" | "allow"): boolean {
    const thread = ctx.threadId ? this.deps.thread(ctx.threadId) : null;
    if (this.disposed || !thread?.signal || thread.signal.aborted || ctx.signal !== thread.signal || (ctx.projectId && ctx.projectId !== thread.projectId)) return false;
    this.prune(ctx.threadId!, thread.signal);
    const key = `${ctx.threadId}\0${name}`;
    const tickets = (this.deferrals.get(key) ?? []).filter((t) => t.thread.signal === thread.signal);
    const pending = [...this.deferrals].filter(([k]) => k.startsWith(`${ctx.threadId}\0`)).reduce((n, [, values]) => n + values.length, 0);
    if (pending >= 64) return false;
    if (ctx.requireApproval || ctx.normalApproval) this.nativeAsks.set(key, { ...thread, signal: thread.signal, forced: ctx.requireApproval === true || this.nativeAsks.get(key)?.forced === true });
    tickets.push({ thread: { ...thread, signal: thread.signal }, policy: this.deps.policy.rulesRevision(), ...(args !== undefined ? { args: argsKey(args) } : {}), ...(decision ? { decision } : {}), ...(ctx.requireApproval ? { requireApproval: true } : {}), ...(ctx.normalApproval ? { normalApproval: true } : {}) });
    this.deferrals.set(key, tickets); return true;
  }

  /** Consume only one pinned ticket. Policy/context/input changes must refuse,
   * not silently turn the engine's earlier deferral into permission to execute. */
  takeDeferral(name: string, args: Record<string, unknown>, ctx: ToolContext, decision?: "ask" | "allow" | null): false | NativeConnectorPermission {
    const key = `${ctx.threadId}\0${name}`, thread = ctx.threadId ? this.deps.thread(ctx.threadId) : null;
    if (!thread?.signal || thread.signal.aborted || ctx.signal?.aborted) throw new Error("No active originating turn for deferred permission.");
    this.prune(ctx.threadId!, thread.signal);
    const native = this.nativeAsks.get(key);
    if (native && (native.projectId !== thread.projectId || native.permissionMode !== thread.permissionMode || native.kind !== thread.kind || native.agent !== thread.agent)) throw new Error("The native Ask context changed; retry in a fresh turn.");
    const tickets = (this.deferrals.get(key) ?? []).filter((t) => t.thread.signal === thread.signal);
    // Older protocols cannot correlate a callback with an MCP request ID. Keep
    // the stronger native Ask on this target for the rest of its originating
    // turn, so concurrent identical calls cannot steal a one-use requirement.
    if (!tickets.length) { this.deferrals.delete(key); return native ? { ask: true, forced: native.forced } : false; }
    const index = tickets.findIndex((t) => t.args === undefined || t.args === argsKey(args));
    if (index < 0) throw new Error("The deferred tool input changed; retry the call.");
    const ticket = tickets.splice(index, 1)[0]!;
    if (tickets.length) this.deferrals.set(key, tickets); else this.deferrals.delete(key);
    if (ticket.policy !== this.deps.policy.rulesRevision() || ticket.thread.projectId !== thread.projectId
      || ticket.thread.permissionMode !== thread.permissionMode || ticket.thread.kind !== thread.kind || ticket.thread.agent !== thread.agent
      || (ticket.decision && ticket.decision !== decision)) throw new Error("The deferred permission policy or originating context changed; retry the call.");
    return { ask: Boolean(native) || ticket.requireApproval === true || ticket.normalApproval === true, ...(native?.forced || ticket.requireApproval ? { forced: true } : {}) };
  }

  private async run(tool: HarnessTool, bound: string | undefined, args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolOutput> {
    if (this.disposed) return error("Managed tools are shutting down.");
    if (bound && ctx?.threadId && ctx.threadId !== bound) return error("This managed tool belongs to another thread.");
    if (ctx?.signal?.aborted) return error("The managed tool caller stopped.");
    const policy = this.deps.policy.rulesRevision();
    const child = this.child(tool, args), readOnly = child ? child.tool.effect === "read" : tool.effect === "read";
    const own = this.deps.policy.rules({ kind: "tool", name: tool.name }, readOnly);
    const inner = child ? this.deps.policy.rules({ kind: "tool", name: child.tool.name }, readOnly) : null;
    const decision = own === "ask" || inner === "ask" ? "ask" : own === "allow" || inner === "allow" ? "allow" : null;
    const forced = decision === "ask";
    const threadId = bound ?? ctx?.threadId;
    // Unscoped legacy callers retain their behaviour, except they cannot satisfy a
    // forced Ask by inventing an approval argument or using an unrelated turn.
    if (!threadId) return forced ? error("This tool requires approval from its originating active turn.") : tool.run(args, ctx);
    const thread = this.deps.thread(threadId);
    const turn = thread?.signal;
    if (!thread || !turn || turn.aborted) return error("No active originating turn for this managed tool.");
    if (ctx?.projectId && ctx.projectId !== thread.projectId) return error("This managed tool belongs to another project.");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, turn, ...(ctx?.signal ? [ctx.signal] : [])]);
    const calls = this.threads.get(threadId) ?? new Set<AbortController>();
    calls.add(controller); this.threads.set(threadId, calls); this.active.add(controller);
    const current = () => {
      const now = this.deps.thread(threadId);
      return !this.disposed && !signal.aborted && this.deps.policy.rulesRevision() === policy
        && now?.signal === turn && now.projectId === thread.projectId && now.permissionMode === thread.permissionMode
        && now.kind === thread.kind && now.agent === thread.agent;
    };
    try {
      if (!current()) return error("Plugin rules or the originating turn changed; retry the call.");
      this.prune(threadId, turn);
      let input = args;
      const deferred = this.deferrals.has(`${threadId}\0${tool.name}`) || this.nativeAsks.has(`${threadId}\0${tool.name}`);
      const childDeferred = child && (this.deferrals.has(`${threadId}\0${child.tool.name}`) || this.nativeAsks.has(`${threadId}\0${child.tool.name}`));
      if (forced || deferred || childDeferred || child || ctx?.managedApproval) {
        // A rule cannot turn approval into permission for a Plan-mode mutation.
        if ((forced || deferred || childDeferred) && thread.permissionMode === "plan" && !readOnly) return error("Plan mode cannot run this managed mutation or unknown tool.");
        const parsed = z.object(tool.input).strict().safeParse(args);
        if (!parsed.success) return error(`Invalid managed tool input: ${parsed.error.message.slice(0, 2000)}`);
        // Freeze the actual input before waiting, not just its displayed summary.
        input = JSON.parse(stableStringify(parsed.data)) as Record<string, unknown>;
        const ticket = this.takeDeferral(tool.name, input, { ...ctx, threadId, projectId: thread.projectId, signal }, decision);
        const childTicket = child ? this.takeDeferral(child.tool.name, child.args, { ...ctx, threadId, projectId: thread.projectId, signal }, inner) : false;
        const pinned = stableStringify(input);
        let approvedByParent = false;
        if (ctx?.managedApproval) {
          const proof = this.delegated.get(ctx.managedApproval); this.delegated.delete(ctx.managedApproval);
          if (!proof || proof.name !== tool.name || proof.args !== argsKey(input) || proof.policy !== policy
            || proof.thread.signal !== turn || proof.thread.projectId !== thread.projectId || proof.thread.permissionMode !== thread.permissionMode
            || proof.thread.kind !== thread.kind || proof.thread.agent !== thread.agent) return error("The delegated managed approval is invalid or stale.");
          approvedByParent = true;
        }
        if (!approvedByParent && (forced || (ticket && ticket.ask) || (childTicket && childTicket.ask))) {
          const summary = `${tool.name}\n${(tool.summarize?.(input) ?? pinned).slice(0, 2000)}`;
          if (!await untilStopped(this.deps.approve(threadId, tool.name, summary, signal), signal)) return error("The user denied this managed tool call.");
        }
        if (!current() || stableStringify(input) !== pinned) return error("Plugin rules, the originating turn or approved input changed; retry the call.");
      }
      // Preserve all normal engine approvals, explicit denials and tool-local
      // grants/guards. Allow never changes autoAllow, effect, schema or a fence.
      let proof: object | undefined;
      if (child) {
        proof = {};
        this.delegated.set(proof, { thread: { ...thread, signal: turn }, policy, name: child.tool.name, args: argsKey(child.args) });
      }
      const result = await untilStopped(tool.run(input, { ...ctx, threadId, projectId: thread.projectId, signal, managedApproval: proof }), signal);
      return current() ? result : error("Plugin rules or the originating turn changed; the late result was discarded.");
    } catch (e) { return error(e instanceof Error ? e.message : String(e)); }
    finally {
      this.active.delete(controller); calls.delete(controller);
      if (!calls.size) this.threads.delete(threadId);
    }
  }

  invalidate(): void { for (const controller of this.active) controller.abort(); }
  forgetThread(threadId: string): void {
    for (const controller of this.threads.get(threadId) ?? []) controller.abort();
    for (const bindings of this.bindings.get(threadId) ?? []) bindings.delete(threadId);
    this.bindings.delete(threadId);
    for (const key of this.deferrals.keys()) if (key.startsWith(`${threadId}\0`)) this.deferrals.delete(key);
    for (const key of this.nativeAsks.keys()) if (key.startsWith(`${threadId}\0`)) this.nativeAsks.delete(key);
  }
  dispose(): void { this.disposed = true; this.invalidate(); this.bindings.clear(); this.deferrals.clear(); this.nativeAsks.clear(); this.delegated = new WeakMap(); this.wrapped = new WeakMap(); this.origins = new WeakMap(); }
}
