// Agent tools run in fresh hidden frames, not in the user's visible widget. Every bridge effect is checked in main.
import { z } from "zod";
import { APP_THEME_DEFAULTS } from "../../shared/apps";
import type { PluginTool } from "../../shared/plugin-tools";
import type { AppCallResult, ThreadEvent } from "../../shared/types";
import type { HarnessTool, ToolOutput } from "../agents/types";
import { CHECK_HOST_URL, type CheckWindow } from "./check";
import type { AppCalls } from "./calls";
import type { AppRegistry } from "./registry";
import { appUrl } from "./serve";
import { pluginInputShape } from "./tool-schema";
import { pluginToolName } from "./tool-name";

export const PLUGIN_TOOL_MAX_MS = 30_000;
const MAX_BYTES = 256 * 1024;
const MAX_CARD_BYTES = 64 * 1024;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const error = (text: string): ToolOutput => ({ text, isError: true });

export interface PluginToolsDeps {
  registry: Pick<AppRegistry, "list" | "manifest">;
  calls: Pick<AppCalls, "call" | "storeGet" | "storeSet">;
  createWindow(): CheckWindow;
  signal(threadId: string): AbortSignal | undefined;
  /** Single-use main permission request. Never delegates trust to the model or the plugin. */
  approve(threadId: string, title: string, summary: string, signal: AbortSignal, connector: boolean, forced?: boolean): Promise<boolean>;
  forceAsk?(name: string, args?: Record<string, unknown>, threadId?: string): boolean;
  rulesRevision?(): string;
  emit(threadId: string, event: ThreadEvent): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export class PluginTools {
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private active = new Map<string, AbortController>();
  private revisions = new Map<string, number>();
  private disposed = false;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private deps: PluginToolsDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  /** Fixed per thread like its other tools. Off/removal/update is still checked on every invocation. */
  tools(threadId: string, projectId: string | null): HarnessTool[] {
    return this.deps.registry.list(projectId).filter((a) => a.enabled !== false && !a.error).flatMap((app) => {
      const manifest = this.deps.registry.manifest(app.key);
      return (manifest?.tools ?? []).map((tool): HarnessTool => ({
        name: pluginToolName(app.name, tool.name),
        description: `${app.title}: ${tool.description}`,
        input: pluginInputShape(tool.inputSchema),
        // Main always handles permission; ACP/HTTP calls cannot skip it. Not an alwaysLoad tool.
        autoAllow: true,
        pluginRulesHandled: true,
        effect: "mutate",
        run: async (args, ctx) => {
          if (ctx?.threadId && ctx.threadId !== threadId) return error("This tool belongs to a different thread.");
          if (this.disposed || this.queued >= 16) return error("Plugin tools are busy or shutting down; try again.");
          const revision = this.revisions.get(app.key) ?? 0;
          const policy = this.deps.rulesRevision?.() ?? "";
          this.queued++;
          const run = this.queue.catch(() => {}).then(() => this.run(app.key, app.title, tool, manifest?.toolEntry ?? manifest!.entry, threadId, projectId, args, revision, policy, ctx?.signal));
          this.queue = run;
          try { return await run; } finally { this.queued--; }
        },
      }));
    });
  }

  invalidate(key: string): void {
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    this.active.get(key)?.abort();
  }

  invalidateRules(): void {
    for (const controller of this.active.values()) controller.abort();
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.active.values()) controller.abort();
  }

  private async run(key: string, title: string, tool: PluginTool, entry: string, threadId: string, projectId: string | null, args: unknown, revision: number, policy: string, callerSignal?: AbortSignal): Promise<ToolOutput> {
    const turn = this.deps.signal(threadId);
    if (!turn || turn.aborted || callerSignal?.aborted || this.disposed) return error("No running turn for this plugin tool.");
    const controller = new AbortController();
    const signal = AbortSignal.any([turn, controller.signal, ...(callerSignal ? [callerSignal] : [])]);
    this.active.set(key, controller);
    let win: CheckWindow | undefined;
    const destroy = () => { try { win?.destroy(); } catch { /* Already gone. */ } };
    signal.addEventListener("abort", destroy, { once: true });
    const current = () => {
      const manifest = this.deps.registry.manifest(key);
      return !signal.aborted && !this.disposed && (this.revisions.get(key) ?? 0) === revision && (this.deps.rulesRevision?.() ?? "") === policy && manifest && (manifest.toolEntry ?? manifest.entry) === entry && JSON.stringify(manifest.tools?.find((t) => t.name === tool.name)) === JSON.stringify(tool);
    };
    try {
      if (!current()) return error("This plugin is Off, removed or changed. Start a new thread for its current tools.");
      const parsed = z.object(pluginInputShape(tool.inputSchema)).strict().safeParse(args);
      if (!parsed.success) return error(`Invalid plugin tool input: ${parsed.error.message.slice(0, 2000)}`);
      if (Buffer.byteLength(JSON.stringify(parsed.data)) > 32 * 1024) return error("Plugin tool inputs are limited to 32 KB.");
      const name = pluginToolName(key.split("~").at(-1)!, tool.name);
      const summary = `${tool.name}\n${JSON.stringify(parsed.data).slice(0, 2000)}`;
      const forced = this.deps.forceAsk?.(name, parsed.data, threadId);
      const approved = forced === undefined ? await this.deps.approve(threadId, title, summary, signal, false) : await this.deps.approve(threadId, title, summary, signal, false, forced);
      if (!approved) return error("The user declined this plugin tool (or Plan mode forbids it).");
      if (!current()) return error("This plugin changed or the turn stopped.");
      win = this.deps.createWindow();
      // A failed/blank/crashed host must not leave the tool promise open indefinitely, even during startup.
      const bounded = async (work: () => Promise<unknown>, ms: number, message: string): Promise<unknown> => {
        if (signal.aborted) throw new Error("The plugin call stopped.");
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stopped!: () => void;
        const limit = new Promise<never>((_, reject) => {
          stopped = () => reject(new Error("The plugin call stopped."));
          signal.addEventListener("abort", stopped, { once: true });
          timer = setTimeout(() => { destroy(); reject(new Error(message)); }, ms);
        });
        try { return await Promise.race([work(), limit]); }
        finally { clearTimeout(timer); signal.removeEventListener("abort", stopped); }
      };
      await bounded(() => win!.load(CHECK_HOST_URL), 8000, "Plugin tool host did not load.");
      if (!current()) return error("This plugin changed or the turn stopped.");
      const theme = { cubiqApp: 1, op: "theme", scheme: "light", vars: APP_THEME_DEFAULTS.light };
      const evaluate = (script: string) => bounded(() => win!.evaluate(script), 2000, "Plugin frame stopped responding.");
      await evaluate(`window.__cq.start(${JSON.stringify(appUrl(key, entry))}, ${JSON.stringify(theme)}, true)`);
      let invoked = false;
      let calls = 0;
      let pending = 0;
      let elapsed = 0;
      let last = this.now();
      let result: Record<string, unknown> | undefined;
      const reply = async (id: unknown, body: AppCallResult) => {
        if (!current() || !Number.isSafeInteger(id)) return;
        const safe = "approval" in body ? { ok: false, error: "Approval was not granted." } : body;
        await evaluate(`window.__cq.reply(${JSON.stringify(id)}, ${JSON.stringify(safe)})`).catch(() => {});
      };
      while (current()) {
        const drained = await evaluate("window.__cq.drain()");
        if (!record(drained) || !Array.isArray(drained.queue)) return error("Plugin tool host stopped responding.");
        const registered = drained.queue.some((m) => record(m) && m.op === "tool-register" && m.name === tool.name);
        for (const m of drained.queue.slice(0, 200)) {
          if (!record(m)) continue;
          if (m.op === "tool-result" && m.id === "invoke" && invoked && !result) { result = m; continue; }
          if (!["call", "store.get", "store.set"].includes(String(m.op))) continue;
          if (!invoked || !current()) { await reply(m.id, { ok: false, error: "Bridge effects must happen inside an invoked tool handler." }); continue; }
          if (++calls > 40) { await reply(m.id, { ok: false, error: "Plugin tools may make at most 40 bridge calls." }); continue; }
          if (m.op === "call" && typeof m.server === "string" && typeof m.tool === "string" && record(m.args)) {
            const server = m.server, name = m.tool, input = m.args;
            pending++;
            void this.deps.calls.call(key, projectId, server, name, input, undefined, { signal }).then(async (out) => {
              if (!current()) return;
              if ("approval" in out) {
                const yes = await this.deps.approve(threadId, title, `${server}.${name}\n${out.approval.args}`, signal, true);
                if (!current()) return;
                out = yes ? await this.deps.calls.call(key, projectId, server, name, input, { token: out.approval.token }, { signal }) : { ok: false, error: "The user declined this connector call." };
              }
              await reply(m.id, out);
            }).catch((e: unknown) => reply(m.id, { ok: false, error: e instanceof Error ? e.message : String(e) })).finally(() => { pending--; });
          } else if (m.op === "store.get" && typeof m.key === "string") await reply(m.id, { ok: true, result: this.deps.calls.storeGet(key, m.key) });
          else if (m.op === "store.set" && typeof m.key === "string") await reply(m.id, this.deps.calls.storeSet(key, m.key, m.value));
          else await reply(m.id, { ok: false, error: "Invalid bridge request." });
        }
        if (!invoked && registered && current()) {
          invoked = true;
          await evaluate(`window.__cq.invoke(${JSON.stringify(tool.name)}, ${JSON.stringify(parsed.data)})`);
        }
        if (result && pending === 0 && current()) return this.output(key, threadId, result);
        // User/connector waits are not CPU execution time; turn/caller aborts still destroy immediately.
        const now = this.now();
        if (!pending) elapsed += now - last;
        last = now;
        if (elapsed >= PLUGIN_TOOL_MAX_MS) return error(invoked ? "Plugin tool timed out." : "Plugin did not register its tool handler.");
        await this.sleep(25);
      }
      return error("This plugin changed, was turned Off, or the turn stopped.");
    } catch (e) {
      return error(`Plugin tool failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      signal.removeEventListener("abort", destroy);
      controller.abort();
      destroy();
      if (this.active.get(key) === controller) this.active.delete(key);
    }
  }

  private output(key: string, threadId: string, message: Record<string, unknown>): ToolOutput {
    if (message.ok !== true) return error(String(message.error ?? "Plugin tool failed.").slice(0, 2000));
    const out = message.result;
    if (!record(out) || typeof out.text !== "string" || Object.keys(out).some((k) => !["text", "data", "card"].includes(k))) return error("Plugin tools return { text, data?, card?: { name, data? } }.");
    let json: string;
    try { json = JSON.stringify(out); } catch { return error("Plugin results must be JSON."); }
    if (Buffer.byteLength(json) > MAX_BYTES) return error("Plugin results are limited to 256 KB.");
    if (out.card !== undefined) {
      const c = out.card;
      if (!record(c) || typeof c.name !== "string" || Object.keys(c).some((k) => !["name", "data"].includes(k)) || !this.deps.registry.manifest(key)?.cards?.some((card) => card.name === c.name)) return error("The tool result names an undeclared chat card.");
      const data = c.data ?? out.data ?? null;
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_CARD_BYTES) return error("Chat card data is limited to 64 KB.");
      this.deps.emit(threadId, { kind: "plugin-card", key, card: c.name, data });
    }
    return { text: out.text, ...(out.data !== undefined ? { data: out.data } : {}) };
  }
}
