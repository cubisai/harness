import { randomUUID } from "node:crypto";
import type {
  AgentInfo,
  DiffFile,
  LiveDelta,
  LiveUpdate,
  McpServerEntry,
  PermissionMode,
  PermissionDecision,
  Provenance,
  SendRequest,
  SkillEntry,
  StoredEvent,
  HandoffCheckpoint,
  SwitchMode,
  SwitchResult,
  Thread,
  ThreadEvent,
  ThreadExport,
  Usage,
} from "../shared/types";
import { bindingKey } from "../shared/bindings";
import type { AgentDriver, HarnessTool, ModelSwitch } from "./agents/types";
import {
  annotateUsage,
  drainConfigChanges,
  fingerprint,
  pinnedFingerprint,
  pinnedSet,
  pinToolSet,
  queueConfigChange,
  stableStringify,
  toolSetOf,
} from "./cache-policy";
import { Approvals } from "./approvals";
import type { Store } from "./db";
import { branchLabel, listProjectFiles, workingTreeDiff } from "./git";
import {
  bloatSignal,
  buildCheckpoint,
  checkpointGit,
  codexSeedItems,
  exportThread,
  fitCheckpoint,
  importThread,
  injectWithLedger,
  replacedTokens,
} from "./handoff";
import type { Catalog } from "./skills/catalog";
import { composePrompt } from "./skills/compose";
import { memoryScopeCheck } from "./inject/memory-scope";
import { redactDeep, redactSecrets } from "./inject/redact";

/**
 * Everything the UI can ask for, with no Electron in sight, so it runs
 * under plain Node in tests. index.ts wires it to IPC.
 */
export class Service {
  private running = new Map<string, AbortController>();
  /** Projects already warned about loading the same conventions twice: said once, not every turn. */
  private scopeChecked = new Set<string>();
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();
  /** One Approvals per project, so an allow-always never leaks to another repo. */
  private approvals = new Map<string, Approvals>();
  /** Threads just switched to another agent, with the last usage before the switch, for the first turn's bloat signal. */
  private pendingSignal = new Map<string, Usage | null>();

  private drivers: Map<string, AgentDriver>;

  constructor(
    private store: Store,
    private catalogFor: (cwd: string | null) => Catalog,
    drivers: AgentDriver[],
    private broadcast: (update: LiveUpdate) => void,
    /** Tools the harness offers the agent this turn (the browser pane's, once it's open). */
    private harnessTools: () => HarnessTool[] = () => [],
    /** Defaults for new threads, from the user's settings. */
    private defaults: () => { agent: string | null; permissionMode: PermissionMode } = () => ({ agent: null, permissionMode: "ask" }),
    /** The MCP servers the thread's project gets, for every agent. */
    private mcpServers: (projectId: string | null) => McpServerEntry[] = () => [],
    /** Every provider key the app holds, so no event (error, notice, tool output) can carry one. */
    private secrets: () => string[] = () => [],
  ) {
    if (!drivers.length) throw new Error("no agent drivers");
    this.drivers = new Map(drivers.map((d) => [d.id, d]));
  }

  private driverFor(agent: string): AgentDriver {
    const d = this.drivers.get(agent);
    if (!d) throw new Error(`The agent "${agent}" isn't available. Install it or pick another agent for this thread.`);
    return d;
  }

  private approvalsFor(projectId: string): Approvals {
    let approvals = this.approvals.get(projectId);
    if (!approvals) {
      approvals = new Approvals();
      this.approvals.set(projectId, approvals);
    }
    return approvals;
  }

  private projectPath(projectId: string | null): string | null {
    if (!projectId) return null;
    try {
      return this.store.getProject(projectId).path;
    } catch {
      return null;
    }
  }

  listSkills(projectId?: string): SkillEntry[] {
    // Every enabled winner belongs in the / menu, model-invoked ones included:
    // the user can always start one explicitly. The agent finds the model ones
    // on its own.
    return this.catalogFor(this.projectPath(projectId ?? null)).userSkills;
  }

  listAgents(): AgentInfo[] {
    return [...this.drivers.values()].map((d) => ({
      id: d.id,
      label: d.label,
      models: d.models(),
      defaultModel: d.defaultModel,
      capabilities: d.capabilities,
      ...(d.credentials ? { credentials: d.credentials } : {}),
      ...(d.unsupported ? { unsupported: d.unsupported } : {}),
    }));
  }

  createThread(projectId: string, agent?: string): Thread {
    this.store.getProject(projectId);
    const d = this.defaults();
    const wanted = agent ?? d.agent;
    // A default agent that's no longer installed falls back to the first one.
    const driver = (wanted && this.drivers.get(wanted)) || [...this.drivers.values()][0]!;
    return this.store.createThread(projectId, driver.id, driver.defaultModel, d.permissionMode);
  }

  /**
   * Switching agents keeps every agent's session: switching back resumes the
   * one it had, on the model it last used. A new agent starts fresh.
   */
  updateThread(id: string, patch: Partial<Pick<Thread, "title" | "model" | "permissionMode" | "agent" | "pinned" | "archived">>): Thread {
    const current = this.store.getThread(id);
    if (patch.agent && patch.agent !== current.agent) {
      if (this.running.has(id)) throw new Error("Stop the running turn before switching agents.");
      const { agent, ...rest } = patch;
      return this.applySwitch(current, agent, current.bindings[bindingKey(agent)]?.resumeCursor ? "back" : "fresh", rest.model);
    }
    return this.store.updateThread(id, patch);
  }

  /**
   * Move a thread to another agent. A handoff builds a checkpoint of the
   * thread, fits it to the budget, drops a git ref to return to, and seeds a
   * new session through the best channel the agent has; "fresh" starts it
   * with nothing; "back" resumes the session it already had. Every switch
   * resets trust: the default permission mode, and approvals are per agent.
   * A refused switch changes nothing.
   */
  async switchAgent(threadId: string, agent: string, mode: SwitchMode): Promise<SwitchResult> {
    if (this.running.has(threadId)) return { ok: false, reason: "Stop the running turn before switching agents." };
    const thread = this.store.getThread(threadId);
    if (agent === thread.agent) return { ok: false, reason: "This thread already runs that agent." };
    const driver = this.drivers.get(agent);
    if (!driver) return { ok: false, reason: `The agent "${agent}" isn't available.` };
    if (mode === "back" && !thread.bindings[bindingKey(agent)]?.resumeCursor) {
      return { ok: false, reason: `There's no earlier ${driver.label} conversation in this thread to go back to.` };
    }
    if (mode !== "handoff") return { ok: true, mode, thread: this.applySwitch(thread, agent, mode) };

    const channel = driver.capabilities.seeding ?? "none";
    if (channel === "none" || (channel === "inject-items" && !driver.seed)) {
      return { ok: false, reason: `${driver.label} has no way to receive a handoff here. Start fresh instead.` };
    }
    // Everything that can refuse runs before anything changes.
    const project = this.store.getProject(thread.projectId);
    const events = this.store.listEvents(threadId);
    const cp = await buildCheckpoint(this.store, threadId);
    const count = driver.countTokens;
    const fit = await fitCheckpoint(cp, {
      countTokens: count ? (text) => count(text, driver.defaultModel) : undefined,
      contextWindow: null,
      replacedTokens: replacedTokens(events),
    });
    if (!fit.ok) return { ok: false, reason: fit.reason };
    const git = await checkpointGit(project.path, cp.lastSeq);
    if (!git.ok && git.kind === "dirty") return { ok: false, reason: git.reason };

    const switched = this.applySwitch(thread, agent, "handoff");
    if (!git.ok) this.emit(threadId, { kind: "notice", text: `${git.reason} The handoff goes ahead without one.` });
    const seeded = { channel, tokens: fit.tokens, tier: fit.tier, estimated: fit.estimated };
    const size = `${fit.estimated ? "about " : ""}${formatK(fit.tokens)} tokens`;
    const detail = fit.tier === 0 ? "" : fit.tier === 1 ? ", tool output shortened" : ", decisions and git state only";
    this.emit(threadId, { kind: "handoff", phase: "seeded", text: `Handed off to ${driver.label} (${size}${detail}).`, from: thread.agent, to: agent, tokens: fit.tokens, tier: fit.tier }, {
      agent: thread.agent,
      model: thread.model,
      provider: null,
      instanceId: null,
    });
    try {
      const sent = await this.seedHandoff(switched, driver, cp, fit.text, project.path);
      return { ok: true, mode, thread: this.store.getThread(threadId), seeded: { ...seeded, sent }, gitRef: git.ok ? git.ref : null };
    } catch (err) {
      const warning = `The handoff didn't reach ${driver.label}: ${err instanceof Error ? err.message : String(err)}. It starts without the earlier messages.`;
      this.emit(threadId, { kind: "error", message: warning });
      return { ok: true, mode, thread: this.store.getThread(threadId), gitRef: git.ok ? git.ref : null, warning };
    }
  }

  /** The switch itself: agent, model, trust reset, and the marker the first turn's bloat signal reads. */
  private applySwitch(thread: Thread, agent: string, mode: SwitchMode, model?: string): Thread {
    const driver = this.driverFor(agent);
    const resumes = mode === "back";
    const last = resumes ? this.lastModel(thread.id, agent) : null;
    const pick = model ?? (last && driver.models().some((m) => m.id === last) ? last : driver.defaultModel);
    // Trust doesn't carry across agents: the default permission mode again, and
    // approvals are kept per agent, so none of the old agent's apply.
    const permissionMode = this.defaults().permissionMode;
    this.pendingSignal.set(thread.id, this.previousTurnEnd(thread.id, thread.agent)?.usage ?? null);
    this.store.updateThread(thread.id, { agent, model: pick, permissionMode });
    // A handoff or a fresh start opens a new session even when the agent has one.
    const updated = resumes ? this.store.getThread(thread.id) : this.store.updateThread(thread.id, { sessionId: null });
    if (resumes) {
      this.emit(thread.id, { kind: "notice", text: `Back to ${driver.label}. It resumes its own conversation and hasn't seen the messages since it last ran.` });
    }
    this.broadcast({ type: "thread", thread: updated });
    return updated;
  }

  /**
   * Seed the new session once, through the injection ledger. Codex takes the
   * history as items without a turn; Claude and ACP agents get one synthetic
   * first message, and their reply is stored as a handoff event, not a turn.
   */
  private async seedHandoff(thread: Thread, driver: AgentDriver, cp: HandoffCheckpoint, text: string, cwd: string): Promise<number> {
    const checkpointId = `${thread.id}:${cp.lastSeq}:${driver.id}`;
    const provenance: Provenance = { agent: driver.id, model: thread.model, provider: null, instanceId: null };
    const onSession = (sessionId: string) => {
      if (sessionId !== this.store.getThread(thread.id).sessionId) {
        this.broadcast({ type: "thread", thread: this.store.updateThread(thread.id, { sessionId }) });
      }
    };
    if (driver.capabilities.seeding === "inject-items") {
      const items = codexSeedItems(cp, text);
      const res = await driver.seed!({
        threadId: thread.id,
        sessionId: null,
        cwd,
        model: thread.model,
        permissionMode: thread.permissionMode,
        tools: this.harnessTools(),
        mcpServers: this.mcpServers(thread.projectId),
        items,
        onSession,
        inject: (sessionId, send) =>
          injectWithLedger(this.store, { threadId: thread.id, provider: driver.id, sessionId, checkpointId }, items, `${driver.id}/inject_items`, send),
      });
      return res.sent ?? 0;
    }
    const prompt = `${text}\n---\nThat is context for continuing this thread. Reply with one short sentence saying you have it; don't run any tools yet.`;
    const controller = new AbortController();
    this.running.set(thread.id, controller);
    this.broadcast({ type: "running", threadId: thread.id, running: true });
    try {
      // The session doesn't exist until the prompt goes out, so the ledger keys this checkpoint's new session.
      const target = { threadId: thread.id, provider: driver.id, sessionId: `new:${checkpointId}`, checkpointId };
      const { sent } = await injectWithLedger(this.store, target, [prompt], `${driver.id}/first-message`, async () => {
        let failed: string | null = null;
        await driver.runTurn({
          threadId: thread.id,
          cwd,
          prompt,
          sessionId: null,
          model: thread.model,
          permissionMode: thread.permissionMode,
          signal: controller.signal,
          tools: this.harnessTools(),
          mcpServers: this.mcpServers(thread.projectId),
          provenance,
          onEvent: (event) => {
            if (event.kind === "assistant-text") {
              this.emit(thread.id, { kind: "handoff", phase: "reply", text: event.text, to: driver.id }, provenance);
            } else if (event.kind === "error") {
              failed = event.message;
            } else if (event.kind === "turn-end") {
              this.emit(thread.id, event, provenance);
              this.emitSignal(thread.id, event.usage);
            }
          },
          onTextDelta: () => {},
          onSession,
          requestPermission: async () => "deny",
        });
        if (failed) throw new Error(failed);
      });
      return sent;
    } finally {
      this.running.delete(thread.id);
      this.broadcast({ type: "running", threadId: thread.id, running: false });
    }
  }

  /** The first turn-end after a switch: did the new session reuse the cache or re-seed it (Ch. 10 §10.5)? */
  private emitSignal(threadId: string, usage: Usage | undefined): void {
    if (!usage || !this.pendingSignal.has(threadId)) return;
    const pre = this.pendingSignal.get(threadId)!;
    this.pendingSignal.delete(threadId);
    const signal = bloatSignal(pre, usage);
    const thread = this.store.getThread(threadId);
    const provenance: Provenance = { agent: thread.agent, model: thread.model, provider: null, instanceId: null };
    this.emit(threadId, { kind: "handoff", phase: "signal", text: signal.text, tokens: signal.tokens ?? undefined }, provenance);
  }

  exportThread(threadId: string): ThreadExport {
    return exportThread(this.store, threadId);
  }

  /** Restores an export as a new thread in the project; the original, if it still exists, is untouched. */
  importThread(projectId: string, data: unknown): Thread {
    return importThread(this.store, projectId, data);
  }

  dispose(): void {
    for (const d of this.drivers.values()) d.dispose?.();
  }

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }

  private emit(threadId: string, event: ThreadEvent, provenance: Provenance | null = null): StoredEvent {
    const stored = this.store.appendEvent(threadId, redactDeep(event, this.secrets()), provenance);
    this.broadcast({ type: "event", threadId, stored });
    return stored;
  }

  async send(req: SendRequest): Promise<void> {
    if (this.running.has(req.threadId)) throw new Error("This thread is already running.");
    const thread = this.store.getThread(req.threadId);
    const project = this.store.getProject(thread.projectId);
    const driver = this.driverFor(thread.agent);
    const provenance: Provenance = { agent: thread.agent, model: thread.model, provider: null, instanceId: null };
    const prompt = composePrompt(this.catalogFor(project.path), req.text, req.skill, driver.skillsDelivery);

    this.emit(thread.id, { kind: "user", text: req.text, skill: req.skill });
    if (thread.title === "New thread") {
      const title = titleFrom(req.text, req.skill);
      this.broadcast({ type: "thread", thread: this.store.updateThread(thread.id, { title }) });
    }

    const controller = new AbortController();
    this.running.set(thread.id, controller);
    this.broadcast({ type: "running", threadId: thread.id, running: true });
    try {
      if (!this.scopeChecked.has(project.id)) {
        this.scopeChecked.add(project.id);
        for (const text of memoryScopeCheck(project.path)) this.emit(thread.id, { kind: "notice", text });
      }
      let switched = false;
      if (thread.sessionId !== null) {
        const last = this.lastModel(thread.id, thread.agent);
        if (last !== null && last !== thread.model) {
          await this.applyModel(thread.id, last, thread.model);
          switched = true;
        }
      }
      const current = this.store.getThread(thread.id);
      if (!switched && current.sessionId === null && this.store.listEvents(thread.id).length > 1) {
        this.emit(thread.id, { kind: "notice", text: `Now talking to ${driver.label}. It starts without the earlier messages above.` });
      }
      // Pin what shapes the prompt prefix. A tools change is a defect (the
      // prefix changed under a session); a servers-only change is the
      // drivers' expected session rebuild. The fingerprint only moves when a
      // queued change drains, at this turn's boundary.
      const set = toolSetOf(this.harnessTools(), this.mcpServers(thread.projectId));
      const previousSet = pinnedSet(thread.id);
      const toolsChanged = previousSet !== null && stableStringify(previousSet.tools) !== stableStringify(set.tools);
      if (pinnedFingerprint(thread.id) === null) {
        pinToolSet(thread.id, set);
      } else if (fingerprint(set) !== pinnedFingerprint(thread.id)) {
        queueConfigChange(thread.id, { set });
        drainConfigChanges(thread.id);
      }
      let rebuilt = false;
      let compacted = false;
      let answered = false;
      const live = (delta: LiveDelta) => this.broadcast({ type: "delta", threadId: thread.id, delta });
      const scrub = (text: string) => redactSecrets(text, this.secrets());
      await driver.runTurn({
        threadId: thread.id,
        cwd: project.path,
        prompt,
        sessionId: current.sessionId,
        model: thread.model,
        permissionMode: thread.permissionMode,
        signal: controller.signal,
        tools: this.harnessTools(),
        mcpServers: this.mcpServers(thread.projectId),
        provenance,
        onSessionRebuilt: () => {
          rebuilt = true;
        },
        onEvent: (event) => {
          if (event.kind === "compaction") compacted = true;
          if (event.kind === "assistant-text" || event.kind === "tool-use" || event.kind === "thinking" || event.kind === "error" || event.kind === "plan") answered = true;
          // A model that returns nothing at all would otherwise leave the thread silent.
          if (event.kind === "turn-end" && !answered && !controller.signal.aborted) {
            this.emit(thread.id, { kind: "notice", text: `${driver.label} ended the turn without a reply from ${thread.model === "default" ? "its default model" : thread.model}. The model may be unavailable right now; try again or pick another.` }, provenance);
          }
          if (event.kind === "turn-end" && event.usage) {
            // A fresh session starts with a cold cache: nothing to compare against.
            const prev = current.sessionId === null ? null : this.previousTurnEnd(thread.id, thread.agent);
            event = {
              ...event,
              usage: annotateUsage(event.usage, {
                prev: prev?.usage ?? null,
                idleMs: prev ? Date.now() - prev.createdAt : null,
                signals: { toolFingerprintChanged: toolsChanged, modelChanged: switched, compacted, sessionRebuilt: rebuilt },
              }),
            };
          }
          this.emit(thread.id, event, provenance);
          if (event.kind === "turn-end") this.emitSignal(thread.id, event.usage);
        },
        // Live text is scrubbed like stored events. A key split across two deltas can
        // slip through here, but the turn's stored assistant-text event is redacted whole.
        onTextDelta: (text, itemId) => live({ kind: "text-delta", itemId: itemId ?? "", text: scrub(text) }),
        onReasoningDelta: (d) => live({ kind: "reasoning-delta", itemId: d.itemId, text: scrub(d.text), opaque: d.opaque }),
        onReasoningSummary: (d) => live({ kind: "reasoning-summary", ...d, text: scrub(d.text) }),
        onToolInputDelta: (d) => live({ kind: "tool-input-delta", ...d, text: scrub(d.text) }),
        onToolOutputDelta: (d) => live({ kind: "tool-output-delta", ...d, text: scrub(d.text) }),
        onUsageUpdate: (u) => live({ kind: "usage-update", ...u }),
        onThinkingProgress: (p) => live({ kind: "thinking-progress", ...p }),
        onSession: (sessionId) => {
          if (sessionId !== this.store.getThread(thread.id).sessionId) {
            this.broadcast({ type: "thread", thread: this.store.updateThread(thread.id, { sessionId }) });
          }
        },
        requestPermission: (p) => {
          const approvals = this.approvalsFor(project.id);
          // The drivers run the git guard before calling requestPermission, so
          // a remembered approval never skips a guardrail block. Answer
          // "allow-once" so Claude doesn't write the same settings rule again.
          if (approvals.get(thread.agent, p.toolName, p.summary)) return Promise.resolve<PermissionDecision>("allow-once");
          return new Promise<PermissionDecision>((resolve) => {
            const requestId = randomUUID();
            const done = (d: PermissionDecision) => {
              this.pendingPermissions.delete(requestId);
              if (d === "allow-always" && p.canAlwaysAllow) approvals.remember(thread.agent, p.toolName, p.summary);
              resolve(d);
            };
            this.pendingPermissions.set(requestId, done);
            controller.signal.addEventListener("abort", () => done("deny"), { once: true });
            this.broadcast({ type: "permission", request: { requestId, threadId: thread.id, ...p } });
          });
        },
      });
    } finally {
      this.running.delete(thread.id);
      this.broadcast({ type: "running", threadId: thread.id, running: false });
      this.broadcast({ type: "thread", thread: this.store.updateThread(thread.id, {}) });
    }
  }

  interrupt(threadId: string): void {
    this.running.get(threadId)?.abort();
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    this.pendingPermissions.get(requestId)?.(decision);
  }

  /**
   * Move an existing session to another model. Every switch starts the prompt
   * cache over; a driver that can't do it in place gets a fresh session.
   */
  async applyModel(threadId: string, from: string, to: string): Promise<"in-place" | "new-session" | "unsupported"> {
    const thread = this.store.getThread(threadId);
    const driver = this.driverFor(thread.agent);
    const result: ModelSwitch | "unsupported" = driver.setModel
      ? await driver.setModel({ threadId, sessionId: thread.sessionId!, from, to })
      : "unsupported";
    if (result !== "in-place") {
      this.broadcast({ type: "thread", thread: this.store.updateThread(threadId, { sessionId: null }) });
    }
    const models = driver.models();
    const label = (id: string) => models.find((m) => m.id === id)?.label ?? id;
    const text =
      result === "in-place"
        ? `Switched the model from ${label(from)} to ${label(to)}. ${driver.label} keeps the conversation, but the prompt cache starts over, so the next reply may be slower and cost more.`
        : `Switched the model from ${label(from)} to ${label(to)}. ${driver.label} can't change models mid-conversation, so this is a new session without the earlier messages above.`;
    this.emit(threadId, { kind: "notice", text });
    return result;
  }

  private lastModel(threadId: string, agent: string): string | null {
    const events = this.store.listEvents(threadId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.provenance?.agent === agent) return event.provenance.model;
    }
    return null;
  }

  /** The newest stored turn-end for this thread and agent, to compare a cache write against. */
  private previousTurnEnd(threadId: string, agent: string): { usage: Usage; createdAt: number } | null {
    const events = this.store.listEvents(threadId);
    for (let i = events.length - 1; i >= 0; i--) {
      const stored = events[i]!;
      if (stored.event.kind === "turn-end" && stored.event.usage && stored.provenance?.agent === agent) {
        return { usage: stored.event.usage, createdAt: stored.createdAt };
      }
    }
    return null;
  }

  getDiff(projectId: string): Promise<DiffFile[]> {
    return workingTreeDiff(this.store.getProject(projectId).path);
  }

  listFiles(projectId: string): Promise<{ files: string[]; truncated: boolean }> {
    return listProjectFiles(this.store.getProject(projectId).path);
  }

  projectBranch(projectId: string): Promise<string | null> {
    return branchLabel(this.store.getProject(projectId).path);
  }
}

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function titleFrom(text: string, skill?: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  const base = firstLine || (skill ? `/${skill}` : "New thread");
  const withSkill = skill && firstLine ? `/${skill} ${firstLine}` : base;
  return withSkill.length > 60 ? `${withSkill.slice(0, 59)}…` : withSkill;
}
