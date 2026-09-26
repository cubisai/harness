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
  Thread,
  ThreadEvent,
  ThreadExport,
  Usage,
} from "../shared/types";
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
import { workingTreeDiff } from "./git";
import { exportThread, importThread } from "./handoff";
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

  private drivers: Map<string, AgentDriver>;

  constructor(
    private store: Store,
    private catalog: Catalog,
    drivers: AgentDriver[],
    private broadcast: (update: LiveUpdate) => void,
    /** Tools the harness offers the agent this turn (the browser pane's, once it's open). */
    private harnessTools: () => HarnessTool[] = () => [],
    /** Defaults for new threads, from the user's settings. */
    private defaults: () => { agent: string | null; permissionMode: PermissionMode } = () => ({ agent: null, permissionMode: "ask" }),
    /** The user's enabled MCP servers, for every agent. */
    private mcpServers: () => McpServerEntry[] = () => [],
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

  listSkills(): SkillEntry[] {
    // Only user-invoked skills belong in the / menu; the agent finds the
    // model-invoked ones on its own.
    return this.catalog.userSkills;
  }

  listAgents(): AgentInfo[] {
    return [...this.drivers.values()].map((d) => ({ id: d.id, label: d.label, models: d.models(), defaultModel: d.defaultModel, capabilities: d.capabilities }));
  }

  createThread(projectId: string, agent?: string): Thread {
    this.store.getProject(projectId);
    const d = this.defaults();
    const wanted = agent ?? d.agent;
    // A default agent that's no longer installed falls back to the first one.
    const driver = (wanted && this.drivers.get(wanted)) || [...this.drivers.values()][0]!;
    return this.store.createThread(projectId, driver.id, driver.defaultModel, d.permissionMode);
  }

  /** Switching agents starts a fresh conversation: sessions don't carry across agents. */
  updateThread(id: string, patch: Partial<Pick<Thread, "title" | "model" | "permissionMode" | "agent">>): Thread {
    const current = this.store.getThread(id);
    if (patch.agent && patch.agent !== current.agent) {
      if (this.running.has(id)) throw new Error("Stop the running turn before switching agents.");
      const driver = this.driverFor(patch.agent);
      return this.store.updateThread(id, { ...patch, model: patch.model ?? driver.defaultModel, sessionId: null });
    }
    return this.store.updateThread(id, patch);
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
    const prompt = composePrompt(this.catalog, req.text, req.skill, driver.skillsDelivery);

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
      const set = toolSetOf(this.harnessTools(), this.mcpServers());
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
        mcpServers: this.mcpServers(),
        provenance,
        onSessionRebuilt: () => {
          rebuilt = true;
        },
        onEvent: (event) => {
          if (event.kind === "compaction") compacted = true;
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
}

export function titleFrom(text: string, skill?: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  const base = firstLine || (skill ? `/${skill}` : "New thread");
  const withSkill = skill && firstLine ? `/${skill} ${firstLine}` : base;
  return withSkill.length > 60 ? `${withSkill.slice(0, 59)}…` : withSkill;
}
