import type { BackgroundRun } from "../../shared/learn";
import type { ModelOption } from "../../shared/types";
import type { AgentDriver } from "../agents/types";
import { findDuplicate } from "./dedupe";
import { GLOBAL_SCOPE, type MemoryStore, type MemoryType } from "./store";

/** One note change the extractor asked for. */
export interface ExtractOp {
  op: "add" | "update" | "delete";
  file?: string;
  name?: string;
  description?: string;
  type?: MemoryType;
  body?: string;
  /** True when the note corrects or reverses an earlier fact. */
  correction?: boolean;
}

/** One finished turn, as the extractor sees it. */
export interface TurnDelta {
  projectId: string;
  threadId: string;
  agentId: string;
  model: string;
  user: string;
  answer: string;
  /** The agent called memory_write this turn, so it saved its own notes. */
  wroteMemory?: boolean;
}

const TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

/** Cheapest-first model-name hints, in the order they win. */
const CHEAP_HINTS = ["nano", "mini", "flash", "lite", "haiku", "small", "free", "luna"];

/** Reasoning-effort levels from least to most, for the extractor's model. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium"];

/** A secret-looking value must never be written into the shared store. */
export const SECRETISH = /(api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}|sk-[A-Za-z0-9]{16,}/i;

const RUN_TIMEOUT_MS = 120_000;

/** Rough tokens for a string a driver doesn't count: 4 characters each (local, since background.ts imports this module). */
const estimate = (text: string): number => Math.ceil(text.length / 4);

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
    'Set "correction": true when the user corrects or reverses an earlier fact or preference; update or delete the old note rather than keeping both.',
    'A preference or correction about the user that matches a GLOBAL note must update that note (file "global/<file>"), never add a new one.',
    'Output {"ops":[]} when nothing is worth keeping (the common case).',
    'Example: {"ops":[{"op":"add","name":"commit-style","description":"Commit messages stay under 72 characters","type":"feedback","body":"Keep commit messages under 72 characters.\\n**Why:** the user asked.\\n**How to apply:** check the length before committing."}]}',
    "",
    "CURRENT INDEX (global notes are referenced as global/<file>):",
    indexText.trim() ? indexText : "(empty)",
    "",
    "TURN:",
    `User: ${clip(delta.user)}`,
    `Assistant: ${clip(delta.answer)}`,
  ].join("\n");
}

/** Both scopes' indexes for the prompt; global links get a `global/` prefix so ops can name them. */
function buildIndexText(store: MemoryStore, projectId: string): string {
  const project = store.index(projectId).text.trim();
  const global = store.index(GLOBAL_SCOPE).text.replace(/\]\(([^)]+\.md)\)/g, "](global/$1)").trim();
  return `PROJECT NOTES:\n${project || "(empty)"}\n\nGLOBAL NOTES (about the user; hold in every project):\n${global || "(empty)"}`;
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
      const next: ExtractOp = { op: "add", name, description, type, body };
      if (typeof op.correction === "boolean") next.correction = op.correction;
      out.push(next);
    } else if (op.op === "update") {
      const file = typeof op.file === "string" ? op.file : "";
      if (!existingFiles.has(file)) continue;
      const next: ExtractOp = { op: "update", file };
      if (typeof op.name === "string" && op.name.trim()) next.name = op.name.trim().slice(0, 80);
      if (typeof op.description === "string" && op.description.trim()) next.description = op.description.trim().slice(0, 200);
      if (typeof op.body === "string" && op.body.trim()) next.body = op.body.trim().slice(0, 4000);
      if (typeof op.type === "string" && (TYPES as string[]).includes(op.type)) next.type = op.type as MemoryType;
      if (typeof op.correction === "boolean") next.correction = op.correction;
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

/** The scope and bare file an op names: `global/<file>` for global, else this project then global. */
function locate(store: MemoryStore, projectId: string, file: string): { scope: string; file: string } | null {
  if (file.startsWith("global/")) return { scope: GLOBAL_SCOPE, file: file.slice("global/".length) };
  for (const scope of [projectId, GLOBAL_SCOPE]) if (store.read(scope, file)) return { scope, file };
  return null;
}

/** Apply validated ops; each is independent, so one bad note never stops the rest. */
export function applyOps(store: MemoryStore, projectId: string, ops: ExtractOp[]): { added: number; updated: number; deleted: number } {
  let added = 0;
  let updated = 0;
  let deleted = 0;
  for (const op of ops) {
    try {
      if (op.op === "add") {
        // A note about the user holds in every project, so it goes to the global scope.
        const type = op.type ?? "project";
        const scope = type === "user" ? GLOBAL_SCOPE : projectId;
        // Only the target scope's duplicates merge: a same-name note in the other
        // scope is a different fact (this project's vs. the user's) and stays.
        const dup = findDuplicate(store, scope, op.name!, op.description!);
        if (dup) {
          const current = store.read(scope, dup.file);
          store.write(scope, { file: dup.file, name: op.name!, description: op.description!, type: op.type ?? current?.type ?? "project", body: op.body! });
          if (op.correction) store.markCorrection(scope, dup.file);
          updated++;
        } else {
          const file = store.write(scope, { name: op.name!, description: op.description!, type, body: op.body! });
          if (op.correction) store.markCorrection(scope, file);
          added++;
        }
      } else if (op.op === "update" && op.file) {
        const where = locate(store, projectId, op.file);
        const current = where ? store.read(where.scope, where.file) : null;
        if (!where || !current) continue;
        store.write(where.scope, {
          file: where.file,
          name: op.name ?? current.name,
          description: op.description ?? current.description,
          type: op.type ?? current.type,
          body: op.body ?? current.body,
        });
        if (op.correction) store.markCorrection(where.scope, where.file);
        updated++;
      } else if (op.op === "delete" && op.file) {
        const where = locate(store, projectId, op.file);
        if (where && store.remove(where.scope, where.file)) deleted++;
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
  /** Account one model call attempt (ok true/false); shared with self-improve's background accounting. */
  account?: (run: Omit<BackgroundRun, "purpose" | "day" | "at">) => void;
  /** Tokens the project may still spend on memory extraction today; the run is skipped past it. */
  budgetLeft?: (projectId: string) => number;
  /** The project's explicit Settings pick, when it has one; runs instead of the thread's agent, with no fallback. */
  background?: (projectId: string) => { driver: AgentDriver; model: string; effort: string | null } | null;
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
      const chosen = deps.background?.(delta.projectId) ?? null;
      const explicit = chosen?.driver.oneShot ? chosen : null;
      if (!explicit && !driver?.oneShot) return;
      const prompt = buildExtractionPrompt(buildIndexText(deps.store, delta.projectId), { user: delta.user, answer: delta.answer });
      // The estimate doubles (the prompt and its reply), so stop before the day's memory cap would be blown.
      if (deps.budgetLeft && estimate(prompt) * 2 > deps.budgetLeft(delta.projectId)) {
        log(`memory: daily budget spent (${delta.projectId})`);
        return;
      }
      // One accounted attempt: the run counts even when the driver throws, with no reply tokens to add.
      const attempt = async (agent: string, model: string, escalated: boolean, call: () => Promise<string>): Promise<string> => {
        try {
          const reply = await call();
          deps.account?.({ projectId: delta.projectId, agent, model, tokens: estimate(prompt) + estimate(reply), estimated: true, ok: true, escalated });
          return reply;
        } catch (err) {
          deps.account?.({ projectId: delta.projectId, agent, model, tokens: estimate(prompt), estimated: true, ok: false, escalated });
          throw err;
        }
      };
      let text: string;
      if (explicit) {
        // The user chose this model: run only it, never fall back to the thread's own.
        const shot = explicit.driver.oneShot!;
        text = await attempt(explicit.driver.id, explicit.model, false, () => shot({ prompt, model: explicit.model, effort: explicit.effort, signal: controller.signal }));
      } else {
        const shot = driver?.oneShot;
        if (!shot) return;
        const { model, effort } = pickExtractorModel(driver.models(), delta.model);
        try {
          text = await attempt(driver.id, model, false, () => shot({ prompt, model, effort, signal: controller.signal }));
        } catch (err) {
          // The cheap pick may not be runnable on this account: fall back to the thread's own model once.
          if (model === delta.model || controller.signal.aborted) throw err;
          text = await attempt(driver.id, delta.model, true, () => shot({ prompt, model: delta.model, effort: null, signal: controller.signal }));
        }
      }
      const files = new Set(deps.store.list(delta.projectId).map((f) => f.file));
      for (const f of deps.store.list(GLOBAL_SCOPE)) files.add(`global/${f.file}`);
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
    // The agent saved its own notes this turn: nothing to extract, and the
    // thread's pending extraction stays as it was.
    if (req.wroteMemory) return;
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
