// What an app's bridge may do, decided in main: call a connector tool it was granted (read-only tools at once,
// others only after the user says yes in the app's pane), and keep a little JSON of its own. The renderer only
// relays; it can't widen a grant or skip a question.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableStringify } from "../cache-policy";
import type { AppCallResult } from "../../shared/types";
import type { McpToolInfo } from "../mcp/servers";
import { granted } from "./manifest";
import { type AppRegistry, decodeAppKey } from "./registry";

export const APP_RESULT_MAX_BYTES = 256 * 1024;
export const APP_STORE_MAX_BYTES = 1024 * 1024;
const TOKEN_TTL_MS = 120_000;

export type ToolCaller = (
  projectId: string | undefined,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  before: (found: McpToolInfo) => Promise<string | null>,
) => Promise<{ text: string; isError: boolean; data?: unknown }>;

export interface AppCallsDeps {
  registry: Pick<AppRegistry, "manifest"> & Partial<Pick<AppRegistry, "isEnabled">>;
  call: ToolCaller;
  /** `<userData>/app-data`: each app's store and its "always allow" list. */
  dataDir: string;
  /** A Creator thread's real project (its draft uses that project's connectors), or null for global ones. */
  draftProject?: (threadId: string) => string | null;
  now?: () => number;
}

const NEEDS_APPROVAL = "\u0000needs-approval";

export class AppCalls {
  private tokens = new Map<string, { key: string; server: string; tool: string; argsHash: string; exp: number }>();
  private cache = new Map<string, { at: number; result: unknown }>();
  private revisions = new Map<string, number>();
  private now: () => number;

  constructor(private deps: AppCallsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * One bridge call. `approval` is the token the pane got back with the question, sent again once the user said
   * yes (`remember`: for this app from now on).
   */
  async call(key: string, contextProjectId: string | null, server: string, tool: string, args: Record<string, unknown>, approval?: { token: string; remember?: boolean }): Promise<AppCallResult> {
    if (this.deps.registry.isEnabled?.(key) === false) return { ok: false, error: "This app is disabled. Enable it in Library → Apps." };
    const manifest = this.deps.registry.manifest(key);
    const k = decodeAppKey(key);
    if (!manifest || !k) return { ok: false, error: "This app is not installed." };
    const revision = this.revisions.get(key) ?? 0;
    const changed = () => (this.revisions.get(key) ?? 0) !== revision;
    if (!granted(manifest, server, tool)) return { ok: false, error: `"${server}.${tool}" is not in this app's grants (app.json).` };
    // A draft's connectors are its thread's, whatever window relays the call.
    const projectId = k.scope === "project" ? k.projectId : k.scope === "draft" ? (this.deps.draftProject?.(k.threadId) ?? undefined) : (contextProjectId ?? undefined);
    const argsJson = stableStringify(args);
    const argsHash = sha(argsJson);
    const cacheKey = `${key}\u0000${projectId ?? ""}\u0000${server}\u0000${tool}\u0000${argsHash}`;
    const ttl = (manifest.cacheSec ?? 0) * 1000;
    const hit = ttl ? this.cache.get(cacheKey) : undefined;
    if (hit && this.now() - hit.at < ttl) return { ok: true, result: hit.result };

    let wasReadOnly = false;
    const before = async (found: McpToolInfo): Promise<string | null> => {
      if (changed()) return "This app changed; retry the call.";
      if (this.deps.registry.isEnabled?.(key) === false) return "This app is disabled.";
      if (found.readOnly) {
        wasReadOnly = true;
        return null;
      }
      if (this.allowed(key).includes(`${server}.${tool}`)) return null;
      if (approval) {
        const t = this.tokens.get(approval.token);
        this.tokens.delete(approval.token);
        if (t && t.key === key && t.server === server && t.tool === tool && t.argsHash === argsHash && t.exp > this.now()) {
          if (approval.remember) this.allow(key, `${server}.${tool}`);
          return null;
        }
      }
      return NEEDS_APPROVAL;
    };
    const r = await this.deps.call(projectId, server, tool, args, before);
    if (changed()) return { ok: false, error: "This app changed; retry the call." };
    if (this.deps.registry.isEnabled?.(key) === false) return { ok: false, error: "This app is disabled." };
    if (r.isError && r.text === NEEDS_APPROVAL) {
      this.sweepTokens();
      const token = randomBytes(16).toString("hex");
      this.tokens.set(token, { key, server, tool, argsHash, exp: this.now() + TOKEN_TTL_MS });
      return { ok: false, approval: { token, server, tool, args: argsJson.length > 2000 ? `${argsJson.slice(0, 2000)}…` : argsJson } };
    }
    if (r.isError) return { ok: false, error: r.text.slice(0, 4000) || "The tool failed." };
    const result = r.data !== undefined ? r.data : parseJson(r.text);
    const size = Buffer.byteLength(typeof result === "string" ? result : JSON.stringify(result) ?? "", "utf-8");
    if (size > APP_RESULT_MAX_BYTES) return { ok: false, error: `The result is ${Math.round(size / 1024)} KB; the limit is ${APP_RESULT_MAX_BYTES / 1024} KB. Ask for less (a filter, a date range or a page).` };
    // Only read-only results are reused: a write always goes out.
    if (ttl && wasReadOnly) this.cache.set(cacheKey, { at: this.now(), result });
    return { ok: true, result };
  }

  storeGet(key: string, name: string): unknown {
    if (!this.deps.registry.manifest(key)) return null;
    return this.readJson(key, "store")[name] ?? null;
  }

  storeSet(key: string, name: string, value: unknown): AppCallResult {
    if (!this.deps.registry.manifest(key)) return { ok: false, error: "This app is not installed." };
    if (!name || name.length > 200) return { ok: false, error: "Store keys are 1-200 characters." };
    const data = this.readJson(key, "store");
    if (value === null) delete data[name];
    else data[name] = value;
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text, "utf-8") > APP_STORE_MAX_BYTES) return { ok: false, error: `The app's store is limited to ${APP_STORE_MAX_BYTES / 1024} KB.` };
    this.writeJson(key, "store", text);
    return { ok: true, result: null };
  }

  /** Tools this app may call without asking. */
  allowed(key: string): string[] {
    const list = this.readJson(key, "allow").tools;
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];
  }

  /** Forget an app's data and approvals (uninstall). */
  forget(key: string): void {
    for (const kind of ["store", "allow"] as const) this.writeJson(key, kind, "{}");
    this.invalidate(key);
  }

  /** Disable/update drops transient permissions and results, but retains saved app data and remembered grants. */
  invalidate(key: string): void {
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    for (const [token, value] of this.tokens) if (value.key === key) this.tokens.delete(token);
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${key}\u0000`)) this.cache.delete(k);
  }

  private allow(key: string, tool: string): void {
    const tools = [...new Set([...this.allowed(key), tool])].sort();
    this.writeJson(key, "allow", JSON.stringify({ tools }));
  }

  private file(key: string, kind: "store" | "allow"): string {
    return join(this.deps.dataDir, `${key}.${kind}.json`);
  }

  private readJson(key: string, kind: "store" | "allow"): Record<string, unknown> {
    try {
      const v = JSON.parse(readFileSync(this.file(key, kind), "utf-8"));
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  private writeJson(key: string, kind: "store" | "allow", text: string): void {
    mkdirSync(this.deps.dataDir, { recursive: true });
    const target = this.file(key, kind);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, target);
  }

  private sweepTokens(): void {
    const now = this.now();
    for (const [t, v] of this.tokens) if (v.exp <= now) this.tokens.delete(t);
  }
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function parseJson(text: string): unknown {
  const t = text.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return text;
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}
