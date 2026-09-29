import type { ModelOption } from "../../shared/types";
import type { AgentDriver } from "../agents/types";
import type { MemoryStore, MemoryType } from "./store";

/** One note change the extractor asked for. */
export interface ExtractOp {
  op: "add" | "update" | "delete";
  file?: string;
  name?: string;
  description?: string;
  type?: MemoryType;
  body?: string;
}

/** One finished turn, as the extractor sees it. */
export interface TurnDelta {
  projectId: string;
  threadId: string;
  agentId: string;
  model: string;
  user: string;
  answer: string;
}

const TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

/** Cheapest-first model-name hints, in the order they win. */
const CHEAP_HINTS = ["nano", "mini", "flash", "lite", "haiku", "small", "free", "luna"];

/** Reasoning-effort levels from least to most, for the extractor's model. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium"];

/** A secret-looking value must never be written into the shared store. */
const SECRETISH = /(api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}|sk-[A-Za-z0-9]{16,}/i;

const RUN_TIMEOUT_MS = 120_000;

/** A model id's provider: the part before "/" ("opencode/x" → "opencode"), "" when there is none. */
function providerOf(id: string): string {
  const slash = id.indexOf("/");
  return slash < 0 ? "" : id.slice(0, slash);
}

/**
 * The extractor's cheapest model, and the lowest effort it lists (null when neither).
 * The thread's own model wins when it's already cheap; otherwise only models from
 * its provider count, since a catalog can list models the user can't run (paid
 * plans, region locks).
 */
export function pickExtractorModel(models: ModelOption[], current: string): { model: string; effort: string | null } {
  const cheap = (m: ModelOption, hint: string) => m.id.toLowerCase().includes(hint) || m.label.toLowerCase().includes(hint);
  const own = models.find((m) => m.id === current);
  const sameProvider = models.filter((m) => providerOf(m.id) === providerOf(current));
  let pick: ModelOption | null = own && CHEAP_HINTS.some((hint) => cheap(own, hint)) ? own : null;
  for (const hint of CHEAP_HINTS) {
    if (pick) break;
    pick = sameProvider.find((m) => cheap(m, hint)) ?? null;
  }
  const model = pick?.id ?? current;
  const efforts = pick?.efforts ?? models.find((m) => m.id === current)?.efforts ?? [];
  const effort = EFFORT_ORDER.find((level) => efforts.includes(level)) ?? null;
  return { model, effort };
}

/** Clip a block to the prompt's budget, marking that it was cut. */
function clip(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/** The plain-text instruction the extractor sends: the index, then one turn. */
export function buildExtractionPrompt(indexText: string, delta: { user: string; answer: string }): string {
  return [
    "You maintain the long-term memory of a software project shared by several coding agents.",
    'Given the CURRENT INDEX (notes that already exist) and ONE TURN (the user message and the assistant answer), output ONLY a JSON object {"ops":[...]}.',
    "Each op is one of:",
    '- "add": {name, description (one line, at most 150 characters), type: user|feedback|project|reference, body}. The body states the fact, then a "**Why:**" line and a "**How to apply:**" line.',
    '- "update": {file, plus the fields that changed} — file must be one of the index entries.',
    '- "delete": {file} — only when the user says a note is wrong or obsolete.',
    "Record ONLY durable user preferences, feedback on how to work, project goals, constraints, decisions, and external references.",
    "NEVER record code structure, file contents, git history, chat logs, one-off task details, secrets, keys or tokens.",
    "When an index entry already covers a fact, prefer update over add.",
    'Output {"ops":[]} when nothing is worth keeping (the common case).',
    'Example: {"ops":[{"op":"add","name":"commit-style","description":"Commit messages stay under 72 characters","type":"feedback","body":"Keep commit messages under 72 characters.\\n**Why:** the user asked.\\n**How to apply:** check the length before committing."}]}',
    "",
    "CURRENT INDEX:",
    indexText.trim() ? indexText : "(empty)",
    "",
    "TURN:",
    `User: ${clip(delta.user)}`,
    `Assistant: ${clip(delta.answer)}`,
  ].join("\n");
}

/** The first balanced top-level {...} in `text`, or null. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Whether any of these strings looks like a credential. */
function secretish(...values: (string | undefined)[]): boolean {
  return values.some((v) => typeof v === "string" && SECRETISH.test(v));
}

/** Validate and cap the model's ops against the store's current files. */
export function parseOps(text: string, existingFiles: Set<string>): ExtractOp[] {
  const body = firstJsonObject(text);
  if (!body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const raw = (parsed as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(raw)) return [];
  const out: ExtractOp[] = [];
  for (const item of raw) {
    if (out.length >= 5) break;
    if (!item || typeof item !== "object") continue;
    let op = item as Record<string, unknown>;
    // Small models also write {"add": {...}}: read the key as the op.
    if (typeof op.op !== "string") {
      const key = (["add", "update", "delete"] as const).find((k) => op[k] && typeof op[k] === "object");
      if (key) op = { ...(op[key] as Record<string, unknown>), op: key };
    }
    if (op.op === "add") {
      const name = typeof op.name === "string" ? op.name.trim().slice(0, 80) : "";
      const description = typeof op.description === "string" ? op.description.trim().slice(0, 200) : "";
      const body = typeof op.body === "string" ? op.body.trim().slice(0, 4000) : "";
      if (!name || !description || !body) continue;
      if (secretish(name, description, body)) continue;
      const type = typeof op.type === "string" && (TYPES as string[]).includes(op.type) ? (op.type as MemoryType) : "project";
      out.push({ op: "add", name, description, type, body });
    } else if (op.op === "update") {
      const file = typeof op.file === "string" ? op.file : "";
      if (!existingFiles.has(file)) continue;
      const next: ExtractOp = { op: "update", file };
      if (typeof op.name === "string" && op.name.trim()) next.name = op.name.trim().slice(0, 80);
      if (typeof op.description === "string" && op.description.trim()) next.description = op.description.trim().slice(0, 200);
      if (typeof op.body === "string" && op.body.trim()) next.body = op.body.trim().slice(0, 4000);
      if (typeof op.type === "string" && (TYPES as string[]).includes(op.type)) next.type = op.type as MemoryType;
      if (secretish(next.name, next.description, next.body)) continue;
      out.push(next);
    } else if (op.op === "delete") {
      const file = typeof op.file === "string" ? op.file : "";
      if (!existingFiles.has(file)) continue;
      out.push({ op: "delete", file });
    }
  }
  return out;
}

/** Apply validated ops; each is independent, so one bad note never stops the rest. */
export function applyOps(store: MemoryStore, projectId: string, ops: ExtractOp[]): { added: number; updated: number; deleted: number } {
  let added = 0;
  let updated = 0;
  let deleted = 0;
  for (const op of ops) {
    try {
      if (op.op === "add") {
        store.write(projectId, { name: op.name!, description: op.description!, type: op.type ?? "project", body: op.body! });
        added++;
      } else if (op.op === "update" && op.file) {
        const current = store.read(projectId, op.file);
        if (!current) continue;
        store.write(projectId, {
          file: op.file,
          name: op.name ?? current.name,
          description: op.description ?? current.description,
          type: op.type ?? current.type,
          body: op.body ?? current.body,
        });
        updated++;
      } else if (op.op === "delete" && op.file) {
        if (store.remove(projectId, op.file)) deleted++;
      }
    } catch {
      // Best-effort: a single malformed note is skipped.
    }
  }
  return { added, updated, deleted };
}

interface Pending {
  delta: TurnDelta;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * After a turn by an agent without native memory, ask that same agent (on its
 * cheapest model, hidden) for memory add/update/delete ops and apply them.
 * Debounced per thread, one model call at a time, and never throws.
 */
export function createExtractor(deps: {
  store: MemoryStore;
  enabled: (projectId: string) => boolean;
  driverFor: (agentId: string) => AgentDriver | undefined;
  debounceMs?: number;
  log?: (msg: string) => void;
}): { schedule(req: TurnDelta): void; dispose(): void } {
  const debounceMs = deps.debounceMs ?? 30_000;
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const pending = new Map<string, Pending>();
  const active = new Map<string, AbortController>();
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  const run = async (delta: TurnDelta, controller: AbortController): Promise<void> => {
    const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const driver = deps.driverFor(delta.agentId);
      if (!driver?.oneShot) return;
      const { model, effort } = pickExtractorModel(driver.models(), delta.model);
      const prompt = buildExtractionPrompt(deps.store.index(delta.projectId).text, { user: delta.user, answer: delta.answer });
      let text: string;
      try {
        text = await driver.oneShot({ prompt, model, effort, signal: controller.signal });
      } catch (err) {
        // The cheap pick may not be runnable on this account: fall back to the thread's own model once.
        if (model === delta.model || controller.signal.aborted) throw err;
        text = await driver.oneShot({ prompt, model: delta.model, effort: null, signal: controller.signal });
      }
      const files = new Set(deps.store.list(delta.projectId).map((f) => f.file));
      const { added, updated, deleted } = applyOps(deps.store, delta.projectId, parseOps(text, files));
      if (added || updated || deleted) log(`memory: +${added} ~${updated} -${deleted} (${delta.projectId})`);
    } catch (err) {
      log(`memory: extraction failed (${delta.projectId}): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
      if (active.get(delta.threadId) === controller) active.delete(delta.threadId);
    }
  };

  const fire = (threadId: string): void => {
    const entry = pending.get(threadId);
    if (!entry) return;
    pending.delete(threadId);
    // One model call at a time per thread; a still-running one waits a debounce.
    if (active.has(threadId)) {
      const timer = setTimeout(() => fire(threadId), debounceMs);
      timer.unref?.();
      pending.set(threadId, { delta: entry.delta, timer });
      return;
    }
    const controller = new AbortController();
    active.set(threadId, controller);
    chain = chain.then(() => run(entry.delta, controller)).catch(() => {});
  };

  const schedule = (req: TurnDelta): void => {
    if (disposed) return;
    if (!deps.enabled(req.projectId)) return;
    const driver = deps.driverFor(req.agentId);
    if (!driver || !driver.oneShot || driver.capabilities.nativeMemory) return;
    if ((req.user + req.answer).trim().length < 80) return;
    const existing = pending.get(req.threadId);
    if (existing) clearTimeout(existing.timer);
    const delta: TurnDelta = existing ? { ...req, user: `${existing.delta.user}\n\n${req.user}`, answer: req.answer } : req;
    const timer = setTimeout(() => fire(req.threadId), debounceMs);
    timer.unref?.();
    pending.set(req.threadId, { delta, timer });
  };

  const dispose = (): void => {
    disposed = true;
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const controller of active.values()) controller.abort();
    active.clear();
  };

  return { schedule, dispose };
}
