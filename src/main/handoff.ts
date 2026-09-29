import { createHash } from "node:crypto";
import type { HandoffCheckpoint, StoredEvent, Thread, ThreadEvent, ThreadExport, Usage } from "../shared/types";
import { stableStringify } from "./cache-policy";
import { blobRefOf, type LedgerTarget, type Store } from "./db";
import { createRef, gitState, workingTreeDiff } from "./git";

/**
 * Thread export/import: the rollback path for the bindings migration, and
 * how a thread moves to another machine. Later, the handoff checkpoint.
 */

export const THREAD_EXPORT_VERSION = 1;

export function exportThread(store: Store, threadId: string): ThreadExport {
  const thread = store.getThread(threadId);
  const events = store.listEvents(threadId);
  const blobs: Record<string, string> = {};
  for (const { event } of events) {
    const ref = blobRefOf(event);
    if (ref && !(ref.sha256 in blobs)) blobs[ref.sha256] = store.readBlob(ref.sha256);
  }
  return { schemaVersion: THREAD_EXPORT_VERSION, exportedAt: Date.now(), thread, events, blobs };
}

/** Restore an export as a new thread in `projectId`. Everything is checked before anything is written. */
export function importThread(store: Store, projectId: string, data: unknown): Thread {
  const { thread, events, blobs } = validateExport(data);
  store.getProject(projectId);
  for (const [sha, content] of Object.entries(blobs)) store.writeBlob(sha, content);
  return store.restoreThread(projectId, { thread, events });
}

function validateExport(data: unknown): ThreadExport {
  if (!isObject(data)) throw new Error("This file isn't a thread export.");
  const version = data.schemaVersion;
  if (version !== THREAD_EXPORT_VERSION) {
    const which = typeof version === "number" ? `schema version ${version}` : "an unknown schema version";
    throw new Error(`This export is ${which}; this version of the app reads schema version ${THREAD_EXPORT_VERSION}.`);
  }
  const { thread, events, blobs } = data;
  if (
    !isObject(thread) ||
    typeof thread.agent !== "string" ||
    typeof thread.title !== "string" ||
    typeof thread.model !== "string" ||
    typeof thread.permissionMode !== "string"
  ) {
    throw new Error("The export's thread is incomplete.");
  }
  if (!Array.isArray(events) || !events.every((e) => isObject(e) && typeof e.seq === "number" && isObject(e.event) && typeof e.event.kind === "string")) {
    throw new Error("The export's events are incomplete.");
  }
  if (!isObject(blobs) || !Object.values(blobs).every((b) => typeof b === "string")) {
    throw new Error("The export's attached tool outputs are unreadable.");
  }
  for (const stored of events as StoredEvent[]) {
    const ref = blobRefOf(stored.event);
    if (!ref) continue;
    const content = blobs[ref.sha256];
    if (typeof content !== "string") throw new Error(`The export is missing an attached tool output (${ref.sha256}).`);
    if (createHash("sha256").update(content).digest("hex") !== ref.sha256) {
      throw new Error(`An attached tool output in the export is corrupted (${ref.sha256}).`);
    }
  }
  return data as unknown as ThreadExport;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const MAX_MESSAGE_CHARS = 2000;
const MAX_OUTPUT_CHARS = 1000;

/** Config the target agent loads itself, so a handoff never carries it. */
const SELF_LOADED = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "SKILL.md"];
const NOT_CARRIED = "(not carried: the agent loads this itself)";

/** The payload of a tool event as text: strings as-is, anything else JSON. */
function payloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  const json = JSON.stringify(payload);
  return json === undefined ? "" : json;
}

/**
 * Build a structured handoff from a thread's stored events: thread state only,
 * no reasoning, no skill or convention bodies. The target agent loads those.
 */
export async function buildCheckpoint(store: Store, threadId: string, opts?: { beforeSeq?: number; afterSeq?: number }): Promise<HandoffCheckpoint> {
  const thread = store.getThread(threadId);
  const cwd = thread.worktreePath ?? store.getProject(thread.projectId).path;
  const all = store.listEvents(threadId);
  const allEvents = all.filter((e) => (opts?.beforeSeq === undefined || e.seq < opts.beforeSeq) && (opts?.afterSeq === undefined || e.seq > opts.afterSeq));
  const events = allEvents.filter((e) => e.event.kind !== "thinking");

  let from: HandoffCheckpoint["from"] = null;
  for (const stored of events) {
    if (stored.provenance) from = { agent: stored.provenance.agent, model: stored.provenance.model };
  }

  const messages: HandoffCheckpoint["messages"] = [];
  let goal = "";
  for (const { event } of events) {
    // A subagent's inner messages are not the thread's own history.
    if (event.parentId) continue;
    if (event.kind === "user") {
      if (goal === "") goal = event.text.slice(0, MAX_MESSAGE_CHARS);
      messages.push({ role: "user", text: event.text.slice(0, MAX_MESSAGE_CHARS) });
    } else if (event.kind === "assistant-text" || event.kind === "plan-proposal") {
      messages.push({ role: "assistant", text: event.text.slice(0, MAX_MESSAGE_CHARS) });
    }
  }

  const results = new Map<string, Extract<ThreadEvent, { kind: "tool-result" }>>();
  for (const { event } of events) if (event.kind === "tool-result") results.set(event.toolUseId, event);

  const commands: HandoffCheckpoint["commands"] = [];
  for (const { event } of events) {
    if (event.kind !== "tool-use") continue;
    // A subagent's inner tool calls are not commands the thread ran.
    if (event.parentId) continue;
    const result = results.get(event.toolUseId);
    const payload = result?.payload;
    const ref = result ? blobRefOf(result) : null;
    let output: string;
    let artifact: string | null = null;
    if (ref) {
      const preview = isObject(payload) && typeof payload.preview === "string" ? payload.preview : "";
      output = preview.slice(0, MAX_OUTPUT_CHARS);
      artifact = `blobs/${ref.sha256}`;
    } else {
      output = payloadText(payload).slice(0, MAX_OUTPUT_CHARS);
    }
    let exitCode: number | null = null;
    if (isObject(payload)) {
      const code = payload.exitCode ?? payload.exit_code;
      if (typeof code === "number") exitCode = code;
    }
    const serialized = payloadText(event.payload);
    const selfLoaded = event.name === "Skill" || SELF_LOADED.some((m) => event.summary.includes(m) || serialized.includes(m));
    if (selfLoaded) {
      output = NOT_CARRIED;
      artifact = null;
    }
    commands.push({ toolUseId: event.toolUseId, name: event.name, summary: event.summary, isError: result?.isError ?? false, exitCode, output, artifact });
  }

  let lastSeq = 0;
  for (const { seq } of allEvents) lastSeq = seq;

  const lastAssistantText = events.filter((e) => e.event.kind === "assistant-text").at(-1)?.event as
    | Extract<ThreadEvent, { kind: "assistant-text" }>
    | undefined;
  const openQuestions = lastAssistantText && lastAssistantText.text.trim().endsWith("?") ? [lastAssistantText.text] : [];

  const files = (await workingTreeDiff(cwd)).map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions }));
  const git = await gitState(cwd);

  return { threadId, from, builtAt: Date.now(), lastSeq, goal, messages, files, commands, openQuestions, git };
}

export type GitCheckpoint = { ok: true; ref: string } | { ok: false; kind: "no-repo" | "no-commits" | "dirty"; reason: string };

/** A ref to return to before handing off. Refuses a dirty worktree: the checkpoint must be the state the handoff describes. */
export async function checkpointGit(cwd: string, seq: number): Promise<GitCheckpoint> {
  const state = await gitState(cwd);
  if (!state) return { ok: false, kind: "no-repo", reason: "This folder isn't a git repository, so there's no checkpoint to return to." };
  if (!state.head) return { ok: false, kind: "no-commits", reason: "The repository has no commits yet, so there's no checkpoint to return to." };
  if (state.dirty.length) {
    const shown = state.dirty.slice(0, 5).join(", ");
    const more = state.dirty.length > 5 ? ` and ${state.dirty.length - 5} more` : "";
    return {
      ok: false,
      kind: "dirty",
      reason: `Commit or stash your changes first, so the handoff starts from a clean checkpoint: ${shown}${more}.`,
    };
  }
  const ref = `harness-handoff/${seq}`;
  await createRef(cwd, ref, state.head);
  return { ok: true, ref };
}

/** The short outcome line both the rendered checkpoint and the Codex items report. */
function outcomeOf(c: HandoffCheckpoint["commands"][number]): string {
  return c.isError ? "error" : c.exitCode !== null ? `exit ${c.exitCode}` : "ok";
}

/** Render a checkpoint as the prompt an incoming agent reads. Tier 0 is fullest, 2 is decisions only. */
export function renderCheckpoint(cp: HandoffCheckpoint, tier: 0 | 1 | 2, opts?: { commandsAsItems?: boolean }): string {
  const sections: string[] = [];
  const push = (heading: string, body: string[]) => {
    if (body.length) sections.push([heading, ...body].join("\n"));
  };

  if (cp.goal) push("## Goal", [cp.goal]);

  if (tier === 2) {
    const users = cp.messages.filter((m) => m.role === "user").map((m) => `**User:** ${m.text}`);
    push("## Decisions", users);
  } else if (cp.messages.length) {
    sections.push(["## Conversation", ...cp.messages.map((m) => `${m.role === "user" ? "**User:**" : "**Assistant:**"} ${m.text}`)].join("\n"));
  }

  if (tier !== 2 && cp.files.length) {
    push("## Files changed", cp.files.map((f) => `- ${f.path} (${f.status}, +${f.additions} -${f.deletions})`));
  }

  if (!opts?.commandsAsItems && tier === 0 && cp.commands.length) {
    const lines = ["## Commands run"];
    for (const c of cp.commands) {
      lines.push(`- ${c.name}: ${c.summary} → ${outcomeOf(c)}`);
      if (c.output) lines.push("```", c.output, "```");
    }
    sections.push(lines.join("\n"));
  } else if (!opts?.commandsAsItems && tier === 1 && cp.commands.length) {
    const lines = ["## Commands run"];
    for (const c of cp.commands) {
      lines.push(`- ${c.name}: ${c.summary} → ${outcomeOf(c)}${c.artifact ? ` (output: ${c.artifact})` : ""}`);
    }
    sections.push(lines.join("\n"));
  }

  if (tier !== 2) push("## Open questions", cp.openQuestions);

  const workspace = ["## Workspace"];
  if (cp.git) {
    workspace.push(`HEAD ${cp.git.head ?? "none"}`, `branch ${cp.git.branch ?? "none"}`);
    workspace.push(cp.git.dirty.length ? `dirty: ${cp.git.dirty.join(", ")}` : "clean");
  } else {
    workspace.push("not a git repository");
  }
  sections.push(workspace.join("\n"));

  const heading = `# Handoff from ${cp.from ? `${cp.from.agent} (${cp.from.model})` : "an earlier agent"}`;
  const notice = "This is the recorded history of this thread, carried over by the harness. Commands below already ran; their results are recorded, do not run them again.";
  return [heading, notice, ...sections].join("\n\n") + "\n";
}

export const CHECKPOINT_CAP = 4000;

/** min(25% of the destination window, 4k); 4k when the window is unknown. */
export function checkpointCap(contextWindow: number | null): number {
  return contextWindow ? Math.min(Math.floor(contextWindow / 4), CHECKPOINT_CAP) : CHECKPOINT_CAP;
}

/** Conservative estimate when the target has no counter: bytes / 3. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

/** Tokens the handoff replaces: the last turn's whole processed input, else an estimate of the visible conversation. */
export function replacedTokens(events: StoredEvent[]): number {
  // A failed turn reports no usage at all (zeros); it says nothing about the conversation's size.
  let total = 0;
  for (const { event } of events) {
    if (event.kind !== "turn-end" || !event.usage) continue;
    const t = event.usage.inputTokens + (event.usage.cacheReadTokens ?? 0) + (event.usage.cacheWriteTokens ?? 0);
    if (t > 0) total = t;
  }
  if (total > 0) return total;
  const texts: string[] = [];
  for (const { event } of events) {
    if (event.kind === "user" || event.kind === "assistant-text") texts.push(event.text);
  }
  return estimateTokens(texts.join("\n"));
}

export type BloatSignal = { kind: "reused" | "reseeded" | "unavailable"; tokens: number | null; text: string };

/** Read the first turn after a switch against the last one before it (Ch. 10 §10.5): reuse shows as cache reads, a re-seed as cache writes. */
export function bloatSignal(pre: Usage | null, post: Usage, mode: "handoff" | "back" = "handoff"): BloatSignal | null {
  if (post.cacheReadTokens === null) {
    return { kind: "unavailable", tokens: null, text: "This agent doesn't report cache use, so there's no reading on how much of the handoff was reused." };
  }
  const preTotal = pre ? pre.inputTokens + (pre.cacheReadTokens ?? 0) + (pre.cacheWriteTokens ?? 0) : 0;
  if (pre && post.cacheReadTokens > 0 && post.cacheReadTokens >= 0.8 * preTotal) {
    return { kind: "reused", tokens: post.cacheReadTokens, text: `Reused ${k(post.cacheReadTokens)} cached tokens from before the switch.` };
  }
  const tokens = post.inputTokens + (post.cacheWriteTokens ?? 0);
  if (tokens === 0) return null;
  const text =
    mode === "back"
      ? `Re-seeded ${k(tokens)} tokens after switching back: the earlier session's cache had expired.`
      : `Re-seeded ${k(tokens)} tokens after the switch: the agent's own setup plus the handoff.`;
  return { kind: "reseeded", tokens, text };
}

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export type FitResult =
  | { ok: true; text: string; tier: 0 | 1 | 2; tokens: number; estimated: boolean }
  | { ok: false; reason: string; tier: 0 | 1 | 2; tokens: number; estimated: boolean };

/** Fit a checkpoint into the budget by degrading one tier at a time. */
export async function fitCheckpoint(
  cp: HandoffCheckpoint,
  opts: {
    countTokens?: (text: string) => number | Promise<number>;
    contextWindow: number | null;
    replacedTokens: number;
    onTier?: (tier: 0 | 1 | 2, tokens: number) => void;
    commandsAsItems?: boolean;
  },
): Promise<FitResult> {
  const cap = checkpointCap(opts.contextWindow);
  const estimated = !opts.countTokens;
  let tokens = 0;
  for (const tier of [0, 1, 2] as const) {
    const text = opts.commandsAsItems ? renderCheckpoint(cp, tier, { commandsAsItems: true }) : renderCheckpoint(cp, tier);
    const counted = opts.commandsAsItems ? text + "\n" + JSON.stringify(codexSeedItems(cp, text, tier).slice(1)) : text;
    tokens = opts.countTokens ? await opts.countTokens(counted) : estimateTokens(counted);
    opts.onTier?.(tier, tokens);
    if (tokens <= cap) {
      if (tokens > opts.replacedTokens) {
        return { ok: false, reason: `The handoff (${tokens} tokens) is larger than the conversation it replaces (${opts.replacedTokens} tokens). Start fresh instead.`, tier, tokens, estimated };
      }
      return { ok: true, text, tier, tokens, estimated };
    }
  }
  return { ok: false, reason: `Even the shortest handoff (${tokens} tokens) is over the ${cap}-token budget. Start fresh instead.`, tier: 2, tokens, estimated };
}

/**
 * Codex history items for a checkpoint: the rendered text as one user message, then each recorded
 * command as a function_call + function_call_output pair under its original call id. Never reasoning.
 * Tier 0 carries full outputs, tier 1 the outcome line only, tier 2 just the text message.
 */
export function codexSeedItems(cp: HandoffCheckpoint, text: string, tier: 0 | 1 | 2 = 0): unknown[] {
  const message = { type: "message", role: "user", content: [{ type: "input_text", text }] };
  if (tier === 2) return [message];
  return [
    message,
    ...cp.commands.flatMap((c) => [
      { type: "function_call", call_id: c.toolUseId, name: c.name, arguments: JSON.stringify({ summary: c.summary }) },
      { type: "function_call_output", call_id: c.toolUseId, output: tier === 0 ? c.output : `${outcomeOf(c)}${c.artifact ? ` (output: ${c.artifact})` : ""}` },
    ]),
  ];
}

/** sha256 of the canonical item plus the protocol it is sent over, so the same item on another channel is a different injection. */
export function itemFingerprint(item: unknown, protocolId: string): string {
  return createHash("sha256").update(stableStringify(item) + "\n" + protocolId).digest("hex");
}

/** The items the ledger says this target has never received, in input order, deduplicated. */
export function planInjection(store: Store, target: LedgerTarget, items: unknown[], protocolId: string): { item: unknown; fingerprint: string }[] {
  const injected = store.injectedFingerprints(target);
  const seen = new Set<string>();
  const plan: { item: unknown; fingerprint: string }[] = [];
  for (const item of items) {
    const fingerprint = itemFingerprint(item, protocolId);
    if (injected.has(fingerprint) || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    plan.push({ item, fingerprint });
  }
  return plan;
}

/**
 * Send what the ledger says is still missing: intent rows first, the send, then injected.
 * A throw from send marks the batch failed and rethrows; a crash leaves intent rows the next run rolls forward.
 */
export async function injectWithLedger(
  store: Store,
  target: LedgerTarget,
  items: unknown[],
  protocolId: string,
  send: (items: unknown[]) => Promise<void>,
): Promise<{ sent: number; skipped: number }> {
  const plan = planInjection(store, target, items, protocolId);
  if (plan.length === 0) return { sent: 0, skipped: items.length };
  for (const { fingerprint } of plan) store.recordIntent(target, fingerprint);
  try {
    await send(plan.map((p) => p.item));
  } catch (err) {
    for (const { fingerprint } of plan) store.markFailed(target, fingerprint);
    throw err;
  }
  for (const { fingerprint } of plan) store.markInjected(target, fingerprint);
  return { sent: plan.length, skipped: items.length - plan.length };
}
