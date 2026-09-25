import { randomUUID } from "node:crypto";
import type {
  AgentInfo,
  DiffFile,
  LiveUpdate,
  McpServerEntry,
  PermissionMode,
  PermissionDecision,
  SendRequest,
  SkillEntry,
  StoredEvent,
  Thread,
  ThreadEvent,
} from "../shared/types";
import type { AgentDriver, HarnessTool } from "./agents/types";
import type { Store } from "./db";
import { workingTreeDiff } from "./git";
import type { Catalog } from "./skills/catalog";
import { composePrompt } from "./skills/compose";

/**
 * Everything the UI can ask for, with no Electron in sight, so it runs
 * under plain Node in tests. index.ts wires it to IPC.
 */
export class Service {
  private running = new Map<string, AbortController>();
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();

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
  ) {
    if (!drivers.length) throw new Error("no agent drivers");
    this.drivers = new Map(drivers.map((d) => [d.id, d]));
  }

  private driverFor(agent: string): AgentDriver {
    const d = this.drivers.get(agent);
    if (!d) throw new Error(`The agent "${agent}" isn't available. Install it or pick another agent for this thread.`);
    return d;
  }

  listSkills(): SkillEntry[] {
    // Only user-invoked skills belong in the / menu; the agent finds the
    // model-invoked ones on its own.
    return this.catalog.userSkills;
  }

  listAgents(): AgentInfo[] {
    return [...this.drivers.values()].map((d) => ({ id: d.id, label: d.label, models: d.models(), defaultModel: d.defaultModel }));
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

  dispose(): void {
    for (const d of this.drivers.values()) d.dispose?.();
  }

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }

  private emit(threadId: string, event: ThreadEvent): StoredEvent {
    const stored = this.store.appendEvent(threadId, event);
    this.broadcast({ type: "event", threadId, stored });
    return stored;
  }

  async send(req: SendRequest): Promise<void> {
    if (this.running.has(req.threadId)) throw new Error("This thread is already running.");
    const thread = this.store.getThread(req.threadId);
    const project = this.store.getProject(thread.projectId);
    const driver = this.driverFor(thread.agent);
    const prompt = composePrompt(this.catalog, req.text, req.skill, driver.skillCallPrefix);

    this.emit(thread.id, { kind: "user", text: req.text, skill: req.skill });
    if (thread.title === "New thread") {
      const title = titleFrom(req.text, req.skill);
      this.broadcast({ type: "thread", thread: this.store.updateThread(thread.id, { title }) });
    }

    const controller = new AbortController();
    this.running.set(thread.id, controller);
    this.broadcast({ type: "running", threadId: thread.id, running: true });
    try {
      if (thread.sessionId === null && this.store.listEvents(thread.id).length > 1) {
        this.emit(thread.id, { kind: "notice", text: `Now talking to ${driver.label}. It starts without the earlier messages above.` });
      }
      await driver.runTurn({
        threadId: thread.id,
        cwd: project.path,
        prompt,
        sessionId: thread.sessionId,
        model: thread.model,
        permissionMode: thread.permissionMode,
        signal: controller.signal,
        tools: this.harnessTools(),
        mcpServers: this.mcpServers(),
        onEvent: (event) => this.emit(thread.id, event),
        onTextDelta: (text) => this.broadcast({ type: "text-delta", threadId: thread.id, text }),
        onSession: (sessionId) => {
          if (sessionId !== this.store.getThread(thread.id).sessionId) {
            this.broadcast({ type: "thread", thread: this.store.updateThread(thread.id, { sessionId }) });
          }
        },
        requestPermission: (p) =>
          new Promise<PermissionDecision>((resolve) => {
            const requestId = randomUUID();
            const done = (d: PermissionDecision) => {
              this.pendingPermissions.delete(requestId);
              resolve(d);
            };
            this.pendingPermissions.set(requestId, done);
            controller.signal.addEventListener("abort", () => done("deny"), { once: true });
            this.broadcast({ type: "permission", request: { requestId, threadId: thread.id, ...p } });
          }),
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
