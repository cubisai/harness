import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type {
  AgentInfo,
  ArtifactContent,
  ArtifactFile,
  DesignSystemDoc,
  DesignSystemEdit,
  DesignSystemOption,
  DiffFile,
  LiveDelta,
  LiveUpdate,
  McpServerEntry,
  PermissionMode,
  PermissionDecision,
  PendingState,
  PermissionRequest,
  PlanDecision,
  PlanRequest,
  Provenance,
  Question,
  QuestionAnswer,
  SendRequest,
  SkillEntry,
  StoredEvent,
  HandoffCheckpoint,
  SwitchMode,
  SwitchResult,
  Thread,
  ThreadEvent,
  ThreadExport,
  ThreadKind,
  Usage,
} from "../shared/types";
import { bindingKey } from "../shared/bindings";
import { bindExpertSkills, expertBlock, teamAgents, type ExpertDef, type ExpertSkill, type TeamAgent } from "../shared/experts";
import { CRITIQUE_ARTIFACT } from "../shared/artifact-kind";
import type { TweakValues } from "../shared/tweaks";
import { tierFeatures, tierNote, tierOf, type PrototypeTier } from "../shared/tiers";
import type { CommentTarget, DesignComment } from "../shared/comments";
import { designDirName } from "./design/serve";
import { listDesignPages, promoteVariant } from "./design/pages";
import { saveRef } from "./design/refs";
import { addComment, deleteComment, loadComments, saveComments, updateComment } from "./design/comments";
import { applyStyleEdit, applyTextEdit } from "./design/textedit";
import { keepTweaks } from "./design/tweaks";
import { forkSystem, listDesignSystems, materializeSystem, resolveDesignSystem, type DesignSystemInfo } from "./design/systems";
import { parseTokens, setToken } from "./design/tokens";
import { skillsOf } from "../shared/skill-list";
import type { AgentDriver, HarnessTool, ModelSwitch, SessionSeed } from "./agents/types";
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
import { artifactDiff, listArtifacts, opensByItself, readArtifact, recordPlan, recordPseudo, recordTurnArtifacts, type ArtifactDeps } from "./artifacts";
import { runCheck, tailOf } from "./check";
import { evidenceFlags, isTestPath, markerCounts, newMarkers, addedLines as diffAddedLines } from "./evidence";
import type { Store } from "./db";
import { addedSinceHead, branchLabel, createWorktree, dirtyPaths, hasGitDir, isTracked, listProjectFiles, removeWorktree, workingTreeDiff, worktreeBranch } from "./git";
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
import { mentionNote } from "./mentions";
import { providerOfModel } from "../shared/provider-rules";
import { memoryScopeCheck } from "./inject/memory-scope";
import { redactDeep, redactSecrets } from "./inject/redact";
import type { TurnDelta } from "./memory/extractor";
import type { Learner } from "./learn";
import { answersMessage } from "./questions";

/**
 * Everything the UI can ask for, with no Electron in sight, so it runs
 * under plain Node in tests. index.ts wires it to IPC.
 */
export class Service {
  private running = new Map<string, AbortController>();
  private artifacts: ArtifactDeps | null = null;
  private designSystemsDir: string | null = null;
  /** Projects already warned about loading the same conventions twice: said once, not every turn. */
  private scopeChecked = new Set<string>();
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();
  /** The open permission requests themselves, for a window that reloads. */
  private permissionRequests = new Map<string, PermissionRequest>();
  /** Plan requests still open, likewise. */
  private planRequests = new Map<string, PlanRequest>();
  /** Answers to async questions that arrived as the turn ended, sent once it has. */
  private afterTurn = new Map<string, string[]>();
  /** Plans waiting on the user, by request id, with the thread each belongs to. */
  private pendingPlans = new Map<string, { threadId: string; resolve: (d: PlanDecision) => void }>();
  /** Agent questions waiting on the user, by request id. */
  private pendingQuestions = new Map<string, { threadId: string; questions: Question[]; async: boolean; resolve: (a: QuestionAnswer) => void }>();
  /** One Approvals per project, so an allow-always never leaks to another repo. */
  private approvals = new Map<string, Approvals>();
  /** Threads just switched to another agent, with the last usage before the switch and how it switched, for the first turn's bloat signal. */
  private pendingSignal = new Map<string, { usage: Usage | null; mode: "handoff" | "back" }>();
  /** Threads whose next turn goes to an agent that hasn't seen the thread since afterSeq (0 = never). */
  private pendingCatchUp = new Map<string, { afterSeq: number }>();
  /** Called after each finished, non-aborted turn, for background memory extraction. */
  private turnListener: ((d: TurnDelta) => void) | null = null;
  /** Self-improve: scores turns of opted-in projects (null = off everywhere). */
  private learner: Learner | null = null;
  /** Each thread's last user message seq, so an automatic fix round scores as part of the turn it fixes. */
  private rootSeqs = new Map<string, number>();

  private drivers: Map<string, AgentDriver>;

  constructor(
    private store: Store,
    /** A cwd's skills; with a thread, plus its expert's own skills. */
    private catalogFor: (cwd: string | null, threadId?: string) => Catalog,
    drivers: AgentDriver[],
    private broadcast: (update: LiveUpdate) => void,
    /** Tools the harness offers the agent this turn (the browser pane's, once it's open; a design thread's add the design tools). */
    private harnessTools: (thread?: Thread) => HarnessTool[] = () => [],
    /** Defaults for new threads, from the user's settings. */
    private defaults: () => { agent: string | null; permissionMode: PermissionMode } = () => ({ agent: null, permissionMode: "ask" }),
    /** The MCP servers the thread's project gets, for every agent. */
    private mcpServers: (projectId: string | null) => McpServerEntry[] = () => [],
    /** Every provider key the app holds, so no event (error, notice, tool output) can carry one. */
    private secrets: () => string[] = () => [],
    /** Where threads' own worktrees go (the app's data folder); null turns worktree threads off. */
    private worktreesDir: string | null = null,
    /** The expert catalogue: a thread's expertId resolves to a persona injected into its turns. */
    private experts: { get(id: string): ExpertDef | null; packageSkills?(id: string): ExpertSkill[]; skillsDir?(id: string): string | null } | null = null,
  ) {
    if (!drivers.length) throw new Error("no agent drivers");
    this.drivers = new Map(drivers.map((d) => [d.id, d]));
  }

  /** Drivers made at runtime (a saved provider's agent): add or replace these, and drop the others whose id starts with `prefix`. */
  syncDrivers(prefix: string, drivers: AgentDriver[]): void {
    const keep = new Set(drivers.map((d) => d.id));
    for (const id of [...this.drivers.keys()]) if (id.startsWith(prefix) && !keep.has(id)) this.drivers.delete(id);
    for (const d of drivers) this.drivers.set(d.id, d);
  }

  /** Every agent driver, runtime provider agents included (self-improve's background model picks from these). */
  allDrivers(): AgentDriver[] {
    return [...this.drivers.values()];
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
    return [...this.drivers.values()].map((d) => {
      const binary = d.binary?.();
      return {
        id: d.id,
        label: d.label,
        models: d.models(),
        defaultModel: d.defaultModel,
        capabilities: d.capabilities,
        ...(d.credentials ? { credentials: d.credentials } : {}),
        ...(d.unsupported ? { unsupported: d.unsupported } : {}),
        ...(binary ? { binary } : {}),
      };
    });
  }

  createThread(projectId: string, agent?: string, kind: ThreadKind = "chat", designSystem: string | null = null, expertId: string | null = null): Thread {
    this.store.getProject(projectId);
    const d = this.defaults();
    const wanted = agent ?? d.agent;
    // A default agent that's no longer installed falls back to the first one.
    const driver = (wanted && this.drivers.get(wanted)) || [...this.drivers.values()][0]!;
    return this.store.createThread(projectId, driver.id, driver.defaultModel, d.permissionMode, kind, designSystem, expertId);
  }

  /**
   * A thread with its own git worktree on a new branch, so its edits stay off
   * the project's checkout. Nothing is left behind when the worktree can't be made.
   */
  async createWorktreeThread(projectId: string, agent?: string, kind: ThreadKind = "chat", designSystem: string | null = null, expertId: string | null = null): Promise<Thread> {
    if (!this.worktreesDir) throw new Error("Worktree threads aren't available here.");
    const project = this.store.getProject(projectId);
    const thread = this.createThread(projectId, agent, kind, designSystem, expertId);
    const branch = worktreeBranch(project.name, thread.id);
    const dir = join(this.worktreesDir, thread.id);
    try {
      await createWorktree(project.path, dir, branch);
    } catch (err) {
      this.store.deleteThread(thread.id);
      throw err;
    }
    return this.store.setWorktree(thread.id, branch, dir);
  }

  /** Delete a thread; its worktree goes too when it has nothing uncommitted (the branch always stays). */
  async deleteThread(id: string): Promise<void> {
    this.interrupt(id);
    const thread = this.store.getThread(id);
    if (thread.worktreePath) await removeWorktree(this.store.getProject(thread.projectId).path, thread.worktreePath);
    this.store.deleteThread(id);
  }

  /** Delete a project, stopping its running threads and removing any associated worktrees. */
  async deleteProject(id: string): Promise<void> {
    let projectPath: string | null = null;
    try {
      projectPath = this.store.getProject(id).path;
    } catch {
      // already gone
    }
    const threads = this.store.listThreads(id);
    for (const thread of threads) {
      this.interrupt(thread.id);
      if (thread.worktreePath && projectPath) {
        try {
          await removeWorktree(projectPath, thread.worktreePath);
        } catch {
          // worktree removal failure shouldn't block project deletion
        }
      }
    }
    this.approvals.delete(id);
    this.scopeChecked.delete(id);
    this.store.deleteProject(id);
  }

  /** Where a thread's tools run: its own worktree, or the project folder. */
  cwdOf(thread: Thread): string {
    return thread.worktreePath ?? this.store.getProject(thread.projectId).path;
  }

  /**
   * A turn's expert fields: the `<expert>` block for the thread's expert
   * persona and, for a team, its members as subagents. The expert's package
   * skills go into the lead's and the members' prompts as private index
   * blocks, and `expertRoot` is the folder that holds them, so the agents
   * may read a skill's files from there. Empty when the thread has no
   * expert we can resolve.
   */
  private expertInput(thread: Thread): { expert?: string; team?: TeamAgent[]; expertRoot?: string } {
    if (!thread.expertId || !this.experts) return {};
    const def = this.experts.get(thread.expertId);
    if (!def) return {};
    const pkg = this.experts.packageSkills?.(def.id) ?? [];
    const bound = bindExpertSkills(def, pkg);
    const team = teamAgents(def, bound.members);
    const root = pkg.length ? (this.experts.skillsDir?.(def.id) ?? null) : null;
    return { expert: expertBlock(def, bound.lead), ...(team.length ? { team } : {}), ...(root ? { expertRoot: root } : {}) };
  }

  /** A note on a team thread's channel (team_post), shown in the thread as it happens. */
  teamNote(threadId: string, note: { from: string; to: string; text: string }): void {
    this.emit(threadId, { kind: "notice", text: `Team note · ${note.from} → ${note.to}: ${note.text}` });
  }

  /**
   * Teams run members as subagents only on agents that can (subagentTeams);
   * elsewhere the lead works through the roles itself. Said once per thread and agent.
   */
  private noteTeamFallback(thread: Thread, driver: AgentDriver): void {
    if (driver.capabilities.subagentTeams) return;
    const def = thread.expertId && this.experts ? this.experts.get(thread.expertId) : null;
    if (!def || !teamAgents(def).length) return;
    const text = `The ${def.name} team runs as one agent on ${driver.label}: the lead works through its members' roles itself. Claude, OpenCode, Codex and the native agent run members as subagents.`;
    if (this.store.listEvents(thread.id).some((e) => e.event.kind === "notice" && e.event.text === text)) return;
    this.emit(thread.id, { kind: "notice", text });
  }

  /**
   * Switching agents keeps every agent's session: switching back resumes the
   * one it had, on the model it last used. A new agent starts fresh.
   */
  updateThread(id: string, patch: Partial<Pick<Thread, "title" | "model" | "effort" | "contextWindow" | "permissionMode" | "agent" | "pinned" | "archived">>): Thread {
    const current = this.store.getThread(id);
    if (patch.agent && patch.agent !== current.agent) {
      if (this.running.has(id)) throw new Error("Stop the running turn before switching agents.");
      const { agent, ...rest } = patch;
      return this.applySwitch(current, agent, current.bindings[bindingKey(agent)]?.resumeCursor ? "back" : "fresh", rest.model);
    }
    // A model change drops an effort the new model doesn't offer; null is the model's default.
    const next = { ...patch };
    const effort = patch.effort !== undefined ? patch.effort : current.effort;
    if (patch.model !== undefined && effort !== null) {
      const efforts = this.driverFor(current.agent).models().find((m) => m.id === (patch.model ?? current.model))?.efforts;
      if (!efforts || !efforts.includes(effort)) next.effort = null;
    }
    // A model change also drops a context-window override picked for the old model.
    if (patch.model !== undefined && patch.contextWindow === undefined) next.contextWindow = null;
    return this.store.updateThread(id, next);
  }

  /**
   * Move a thread to another agent. A handoff builds a checkpoint of the
   * thread, fits it to the budget, drops a git ref to return to, and seeds a
   * new session through the best channel the agent has; "fresh" starts it
   * with nothing; "back" resumes the session it already had. Every switch
   * resets trust: the default permission mode, and approvals are per agent.
   * A refused switch changes nothing.
   */
  /** `model`: the new agent's model to land on (a provider model picked from its list), else its default. */
  async switchAgent(threadId: string, agent: string, mode: SwitchMode, model?: string): Promise<SwitchResult> {
    if (this.running.has(threadId)) return { ok: false, reason: "Stop the running turn before switching agents." };
    const thread = this.store.getThread(threadId);
    if (agent === thread.agent) return { ok: false, reason: "This thread already runs that agent." };
    const driver = this.drivers.get(agent);
    if (!driver) return { ok: false, reason: `The agent "${agent}" isn't available.` };
    if (mode === "back" && !thread.bindings[bindingKey(agent)]?.resumeCursor) {
      return { ok: false, reason: `There's no earlier ${driver.label} conversation in this thread to go back to.` };
    }
    if (mode !== "handoff") {
      const switched = this.applySwitch(thread, agent, mode, model);
      // "Start fresh" is the user's explicit choice: nothing is carried over.
      if (mode === "fresh") this.pendingCatchUp.delete(threadId);
      return { ok: true, mode, thread: switched };
    }

    const channel = driver.capabilities.seeding ?? "none";
    if (channel === "none" || (channel === "inject-items" && !driver.seed)) {
      return { ok: false, reason: `${driver.label} has no way to receive a handoff here. Start fresh instead.` };
    }
    // Everything that can refuse runs before anything changes.
    const events = this.store.listEvents(threadId);
    const cp = await buildCheckpoint(this.store, threadId);
    const count = driver.countTokens;
    const fit = await fitCheckpoint(cp, {
      countTokens: count ? (text) => count(text, driver.defaultModel) : undefined,
      contextWindow: null,
      replacedTokens: replacedTokens(events),
      commandsAsItems: channel === "inject-items",
    });
    if (!fit.ok) return { ok: false, reason: fit.reason };
    const git = await checkpointGit(this.cwdOf(thread), cp.lastSeq);
    if (!git.ok && git.kind === "dirty") return { ok: false, reason: git.reason };

    const switched = this.applySwitch(thread, agent, "handoff", model);
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
      const sent = await this.seedHandoff(switched, driver, cp, fit.text, fit.tier, this.cwdOf(thread));
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
    // An effort the new agent's model doesn't offer goes back to the model's default.
    const efforts = driver.models().find((m) => m.id === pick)?.efforts;
    const effort = thread.effort && efforts?.includes(thread.effort) ? thread.effort : null;
    if (mode === "fresh") this.pendingSignal.delete(thread.id);
    else this.pendingSignal.set(thread.id, { usage: this.previousTurnEnd(thread.id, thread.agent)?.usage ?? null, mode });
    if (mode === "handoff") {
      // The explicit handoff already seeded the new session.
      this.pendingCatchUp.delete(thread.id);
    } else if (mode === "back") {
      let afterSeq: number | null = null;
      const events = this.store.listEvents(thread.id);
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.provenance?.agent === agent) {
          afterSeq = events[i]!.seq;
          break;
        }
      }
      if (afterSeq === null) this.pendingCatchUp.delete(thread.id);
      else this.pendingCatchUp.set(thread.id, { afterSeq });
    } else {
      const hasUser = this.store.listEvents(thread.id).some((e) => e.event.kind === "user" && !e.event.parentId);
      if (hasUser) this.pendingCatchUp.set(thread.id, { afterSeq: 0 });
      else this.pendingCatchUp.delete(thread.id);
    }
    this.store.updateThread(thread.id, { agent, model: pick, permissionMode, effort });
    // A handoff or a fresh start opens a new session even when the agent has one.
    const updated = resumes ? this.store.getThread(thread.id) : this.store.updateThread(thread.id, { sessionId: null });
    if (resumes) {
      this.emit(thread.id, { kind: "notice", text: `Back to ${driver.label}. It resumes its own conversation; what it missed is handed over with your next message.` });
    }
    this.broadcast({ type: "thread", thread: updated });
    return updated;
  }

  /**
   * Seed the new session once, through the injection ledger. Codex takes the
   * history as items without a turn; Claude and ACP agents get one synthetic
   * first message, and their reply is stored as a handoff event, not a turn.
   */
  private async seedHandoff(thread: Thread, driver: AgentDriver, cp: HandoffCheckpoint, text: string, tier: 0 | 1 | 2, cwd: string): Promise<number> {
    const checkpointId = `${thread.id}:${cp.lastSeq}:${driver.id}`;
    const provenance: Provenance = { agent: driver.id, model: thread.model, provider: null, instanceId: null };
    const onSession = (sessionId: string) => {
      if (sessionId !== this.store.getThread(thread.id).sessionId) {
        this.broadcast({ type: "thread", thread: this.store.updateThread(thread.id, { sessionId }) });
      }
    };
    if (driver.capabilities.seeding === "inject-items") {
      const items = codexSeedItems(cp, text, tier);
      const res = await driver.seed!({
        threadId: thread.id,
        sessionId: null,
        cwd,
        projectId: thread.projectId,
        design: designOf(thread),
        ...this.expertInput(thread),
        model: thread.model,
        permissionMode: thread.permissionMode,
        tools: this.harnessTools(thread),
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
          projectId: thread.projectId,
          design: designOf(thread),
          ...this.expertInput(thread),
          prompt,
          sessionId: null,
          model: thread.model,
          effort: thread.effort,
          permissionMode: thread.permissionMode,
          signal: controller.signal,
          tools: this.harnessTools(thread),
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
          requestPlanDecision: async () => ({ keep: "" }),
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
    const { usage: pre, mode } = this.pendingSignal.get(threadId)!;
    this.pendingSignal.delete(threadId);
    const signal = bloatSignal(pre, usage, mode);
    if (!signal) return;
    const thread = this.store.getThread(threadId);
    const provenance: Provenance = { agent: thread.agent, model: thread.model, provider: null, instanceId: null };
    this.emit(threadId, { kind: "handoff", phase: "signal", text: signal.text, tokens: signal.tokens ?? undefined }, provenance);
  }

  /** The agent couldn't reopen its stored session: seed a new one from this thread's own log, inside the checkpoint budget, through the ledger so it's never sent twice. */
  private async rehydrate(threadId: string, driver: AgentDriver, reason: string, beforeSeq: number): Promise<SessionSeed | null> {
    this.broadcast({ type: "thread", thread: this.store.updateThread(threadId, { sessionId: null }) });
    const why = reason.trim().replace(/\s+/g, " ").slice(0, 160);
    const lead = `${driver.label} couldn't reopen its earlier session (${why}).`;
    const cp = await buildCheckpoint(this.store, threadId, { beforeSeq });
    const channel = driver.capabilities.seeding ?? "none";
    if (cp.messages.length === 0) {
      this.emit(threadId, { kind: "notice", text: `${lead} This is a new one.` });
      return null;
    }
    if (channel === "none") {
      this.emit(threadId, { kind: "notice", text: `${lead} This is a new one, without the earlier messages above.` });
      return null;
    }
    const events = this.store.listEvents(threadId).filter((e) => e.seq < beforeSeq);
    const count = driver.countTokens;
    const fit = await fitCheckpoint(cp, {
      countTokens: count ? (text) => count(text, driver.defaultModel) : undefined,
      contextWindow: null,
      replacedTokens: replacedTokens(events),
      commandsAsItems: channel === "inject-items",
    });
    if (!fit.ok) {
      this.emit(threadId, { kind: "notice", text: `${lead} This is a new one, without the earlier messages above: ${fit.reason}` });
      return null;
    }
    const checkpointId = `${threadId}:${cp.lastSeq}:${driver.id}:rehydrate`;
    const size = `${fit.estimated ? "about " : ""}${formatK(fit.tokens)} tokens`;
    const handedOver = `${lead} Continued in a new one with this thread's history handed over (${size}).`;
    if (channel === "inject-items") {
      this.emit(threadId, { kind: "notice", text: handedOver });
      this.pendingCatchUp.delete(threadId);
      return {
        inject: async (sessionId, send) => {
          await injectWithLedger(
            this.store,
            { threadId, provider: driver.id, sessionId, checkpointId },
            codexSeedItems(cp, fit.text, fit.tier),
            `${driver.id}/inject_items`,
            send,
          );
        },
      };
    }
    // The session doesn't exist until the prompt goes out, so the ledger keys this checkpoint's new session.
    const { sent } = await injectWithLedger(
      this.store,
      { threadId, provider: driver.id, sessionId: `new:${checkpointId}`, checkpointId },
      [fit.text],
      `${driver.id}/first-message`,
      async () => {},
    );
    if (sent === 0) return null;
    this.emit(threadId, { kind: "notice", text: handedOver });
    this.pendingCatchUp.delete(threadId);
    return { promptPrefix: fit.text };
  }

  /** A catch-up for an agent that missed part of this thread: prefixed to the turn, inside the checkpoint budget, through the ledger so it's never sent twice. */
  private async catchUp(threadId: string, driver: AgentDriver, beforeSeq: number): Promise<string | null> {
    const pending = this.pendingCatchUp.get(threadId);
    if (!pending) return null;
    this.pendingCatchUp.delete(threadId);
    const cp = await buildCheckpoint(this.store, threadId, { afterSeq: pending.afterSeq, beforeSeq });
    if (cp.messages.length === 0 && cp.commands.length === 0) return null;
    const events = this.store.listEvents(threadId).filter((e) => e.seq < beforeSeq);
    const count = driver.countTokens;
    const fit = await fitCheckpoint(cp, {
      countTokens: count ? (t) => count(t, driver.defaultModel) : undefined,
      contextWindow: null,
      replacedTokens: replacedTokens(events),
    });
    if (!fit.ok) {
      this.emit(threadId, { kind: "notice", text: `${driver.label} starts without the earlier messages above: ${fit.reason}` });
      return null;
    }
    const checkpointId = `${threadId}:${pending.afterSeq}-${cp.lastSeq}:${driver.id}:catch-up`;
    const { sent } = await injectWithLedger(this.store, { threadId, provider: driver.id, sessionId: `new:${checkpointId}`, checkpointId }, [fit.text], `${driver.id}/first-message`, async () => {});
    if (sent === 0) return null;
    const size = `${fit.estimated ? "about " : ""}${formatK(fit.tokens)} tokens`;
    this.emit(threadId, { kind: "notice", text: `Handed ${pending.afterSeq === 0 ? "this thread's history" : "what it missed"} to ${driver.label} (${size}).` });
    return fit.text;
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

  /** A listener for finished turns (the background memory extractor); null turns it off. */
  setTurnListener(fn: ((d: TurnDelta) => void) | null): void {
    this.turnListener = fn;
  }

  setLearner(learner: Learner | null): void {
    this.learner = learner;
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
    let thread = this.store.getThread(req.threadId);
    const project = this.store.getProject(thread.projectId);
    const cwd = this.cwdOf(thread);
    // A folder that's been moved or deleted fails the agent with a misleading error;
    // say what's wrong instead, without starting anything or leaving the thread running.
    if (!existsSync(cwd)) {
      const message = thread.worktreePath
        ? `This thread's worktree folder is gone: ${cwd}. Start a new thread.`
        : `Project folder not found: ${cwd}. It was moved or deleted. Use Locate folder… in the project menu, or remove the project.`;
      this.emit(thread.id, { kind: "error", message });
      // The renderer marks the thread running as it sends; settle that too.
      this.broadcast({ type: "running", threadId: thread.id, running: false });
      this.broadcast({ type: "projects-changed" });
      return;
    }
    const driver = this.driverFor(thread.agent);
    // A saved provider is its own agent now: a thread still pinned to one of its
    // models through another agent goes back to that agent's default model.
    const pinnedProvider = providerOfModel(thread.model);
    if (pinnedProvider !== null) {
      thread = this.store.updateThread(thread.id, { model: driver.defaultModel });
      this.broadcast({ type: "thread", thread });
      const label = this.drivers.get(`provider-${pinnedProvider}`)?.label ?? pinnedProvider;
      this.emit(thread.id, {
        kind: "notice",
        text: `${label} is its own agent now. This thread is back on ${driver.label}'s default model; pick ${label} in the model picker to use it.`,
      });
    }
    const compact = req.compact ?? null;
    // /compact needs an agent that compacts on request and a session to compact.
    if (compact && (!driver.capabilities.manualCompact || thread.sessionId === null)) {
      const text = !driver.capabilities.manualCompact
        ? `${driver.label} can't compact on request.`
        : `Nothing to compact yet: this thread has no ${driver.label} session.`;
      this.emit(thread.id, { kind: "notice", text });
      this.broadcast({ type: "running", threadId: thread.id, running: false });
      return;
    }
    // The project's verification gate: off when there's no command; `round` counts the automatic fixes.
    const checkCommand = project.checkCommand?.trim() || null;
    const round = req.checkRound ?? 0;
    // Fix turns are the gate's only token cost; the project caps them (default 1, 0 = none).
    const maxRounds = project.checkFixRounds ?? 1;
    const provenance: Provenance = { agent: thread.agent, model: thread.model, provider: null, instanceId: null };
    const skills = skillsOf(req);
    // A design thread's system is copied into its folder before each turn; a switch is said once, in this prompt.
    const systemNote = compact ? "" : this.prepareDesignSystem(thread) + this.prepareDesignTier(thread);
    const prompt = compact
      ? `/compact${compact.focus ? ` ${compact.focus}` : ""}`
      : composePrompt(this.catalogFor(cwd, thread.id), req.text, skills, driver.skillsDelivery) + mentionNote(cwd, req.mentions) + systemNote;

    const userEvent = this.emit(thread.id, { kind: "user", text: req.text, ...(skills.length ? { skills } : {}) });
    // An automatic fix round never names the thread; the user's message does.
    if (thread.title === "New thread" && !req.checkRound && !compact) {
      const title = titleFrom(req.text, skills);
      this.broadcast({ type: "thread", thread: this.store.updateThread(thread.id, { title }) });
    }

    // Self-improve sees only opted-in projects' real turns; everything it adds is skipped otherwise.
    const learner = !compact && this.learner?.enabled(thread.projectId) ? this.learner : null;
    if (round === 0) this.rootSeqs.set(thread.id, userEvent.seq);
    const rootSeq = this.rootSeqs.get(thread.id) ?? userEvent.seq;
    if (learner && round === 0) learner.onUserMessage({ thread, seq: userEvent.seq, text: req.text });

    const controller = new AbortController();
    this.running.set(thread.id, controller);
    this.broadcast({ type: "running", threadId: thread.id, running: true });
    // Set when a failed check schedules the next automatic fix; fired after this send's finally.
    let followUp: SendRequest | null = null;
    try {
      // Snapshot the working tree before the turn, so an edit the agent reports
      // (or a path git now sees) is what triggers the check and the evidence gate.
      const before = compact ? null : await dirtySet(cwd);
      const pre = learner ? await learner.beforeTurn({ thread, cwd }) : null;
      const testsBefore = before ? await testMarkersOf(cwd, [...before].map(dirtyPath).filter(isTestPath)) : new Map<string, Map<string, number>>();
      if (!this.scopeChecked.has(project.id)) {
        this.scopeChecked.add(project.id);
        for (const text of memoryScopeCheck(cwd)) this.emit(thread.id, { kind: "notice", text });
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
      // Pin what shapes the prompt prefix. A tools change is a defect (the
      // prefix changed under a session); a servers-only change is the
      // drivers' expected session rebuild. The fingerprint only moves when a
      // queued change drains, at this turn's boundary.
      const set = toolSetOf(this.harnessTools(thread), this.mcpServers(thread.projectId));
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
      // The agent reported an edit this turn: a tool-result for an Edit tool-use, or a path git changed.
      const editIds = new Set<string>();
      let edited = false;
      // What the evidence gate reads: the turn's commands and its edits' diffs.
      const commands: string[] = [];
      const editDiffs: { path: string; unified: string }[] = [];
      // What the scorecard reads besides: failing commands, tools used, denials and the turn's size.
      const commandOf = new Map<string, string>();
      const failedCommands: string[] = [];
      const toolNames: string[] = [];
      let denied = 0;
      let toolCalls = 0;
      let turnTokens = 0;
      const live = (delta: LiveDelta) => this.broadcast({ type: "delta", threadId: thread.id, delta });
      const scrub = (text: string) => redactSecrets(text, this.secrets());
      const catchUp = compact ? null : await this.catchUp(thread.id, driver, userEvent.seq);
      const turnPrompt = catchUp ? `${catchUp}\n---\n${prompt}` : prompt;
      if (!catchUp && !switched && current.sessionId === null && this.store.listEvents(thread.id).length > 1) {
        this.emit(thread.id, { kind: "notice", text: `Now talking to ${driver.label}. It starts without the earlier messages above.` });
      }
      this.noteTeamFallback(thread, driver);
      // Files the turn writes by command are found by mtime; 2 s of slack covers coarse filesystem clocks.
      const turnStartedAt = Date.now() - 2000;
      await driver.runTurn({
        threadId: thread.id,
        cwd,
        projectId: thread.projectId,
        design: designOf(thread),
        ...this.expertInput(thread),
        prompt: turnPrompt,
        ...(compact ? { compact } : {}),
        sessionId: current.sessionId,
        model: thread.model,
        effort: thread.effort,
        contextWindow: thread.contextWindow ?? null,
        permissionMode: thread.permissionMode,
        signal: controller.signal,
        tools: this.harnessTools(thread),
        mcpServers: this.mcpServers(thread.projectId),
        provenance,
        ...(learner ? { nudges: true } : {}),
        onSessionRebuilt: () => {
          rebuilt = true;
        },
        onSessionLost: (reason) => this.rehydrate(thread.id, driver, reason, userEvent.seq),
        onEvent: (event) => {
          if (event.kind === "compaction") {
            compacted = true;
            answered = true;
          }
          if (event.kind === "assistant-text" || event.kind === "tool-use" || event.kind === "thinking" || event.kind === "error" || event.kind === "plan") answered = true;
          // An Edit that completed is what makes a file change count even outside git.
          if (event.kind === "tool-use" && event.name === "Edit") editIds.add(event.toolUseId);
          if (event.kind === "tool-result" && !event.isError && editIds.has(event.toolUseId)) {
            edited = true;
            editDiffs.push(...diffsOf(event.payload));
          }
          if (event.kind === "tool-use") {
            const command = (event.payload as { command?: unknown } | undefined)?.command;
            if (typeof command === "string") commands.push(command);
            if (learner) {
              toolCalls++;
              toolNames.push(event.name);
              if (typeof command === "string") commandOf.set(event.toolUseId, command);
            }
          }
          if (learner && event.kind === "tool-result" && event.isError) {
            const command = commandOf.get(event.toolUseId);
            if (command !== undefined) failedCommands.push(command);
          }
          if (learner && event.kind === "turn-end") turnTokens += event.inputTokens + event.outputTokens;
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
          const stored = this.emit(thread.id, event, provenance);
          if (event.kind === "turn-end") {
            this.emitSignal(thread.id, event.usage);
            this.recordArtifacts(thread.id, cwd, stored.seq, turnStartedAt);
          }
        },
        // Live text is scrubbed like stored events. A key split across two deltas can
        // slip through here, but the turn's stored assistant-text event is redacted whole.
        onTextDelta: (text, itemId, parentId) => live({ kind: "text-delta", itemId: itemId ?? "", text: scrub(text), ...(parentId ? { parentId } : {}) }),
        onReasoningDelta: (d) => live({ kind: "reasoning-delta", itemId: d.itemId, text: scrub(d.text), opaque: d.opaque, ...(d.parentId ? { parentId: d.parentId } : {}) }),
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
              if (d === "deny" && !controller.signal.aborted) denied++;
              this.pendingPermissions.delete(requestId);
              this.permissionRequests.delete(requestId);
              if (d === "allow-always" && p.canAlwaysAllow) approvals.remember(thread.agent, p.toolName, p.summary);
              resolve(d);
            };
            this.pendingPermissions.set(requestId, done);
            controller.signal.addEventListener("abort", () => done("deny"), { once: true });
            const request = { requestId, threadId: thread.id, ...p };
            this.permissionRequests.set(requestId, request);
            this.broadcast({ type: "permission", request });
          });
        },
        requestPlanDecision: (p) =>
          new Promise<PlanDecision>((resolve) => {
            const requestId = randomUUID();
            this.pendingPlans.set(requestId, { threadId: thread.id, resolve });
            controller.signal.addEventListener(
              "abort",
              () => {
                this.planRequests.delete(requestId);
                if (this.pendingPlans.delete(requestId)) resolve({ keep: "" });
              },
              { once: true },
            );
            // The proposal is history, not a live row: it takes the same path as driver events.
            const proposal = this.emit(thread.id, { kind: "plan-proposal", text: p.plan });
            // Each round is also the next version of the thread's plan artifact (File panel).
            // Stored as the event was, with secrets already masked.
            if (this.artifacts && proposal.event.kind === "plan-proposal") recordPlan(this.artifacts, { threadId: thread.id, text: proposal.event.text, turnSeq: proposal.seq });
            const request = { requestId, threadId: thread.id, plan: p.plan };
            this.planRequests.set(requestId, request);
            this.broadcast({ type: "plan-approval", request });
          }),
        // An async question doesn't hold the turn, so Stop doesn't take its card away.
        requestUserInput: (questions, opts) => this.ask(thread.id, questions, opts?.async ? [] : [controller.signal], opts?.async === true),
      });
      // The turn finished cleanly: hand it to the memory extractor. A listener
      // failure is its own concern and never touches the thread. An automatic
      // fix turn isn't user intent, so it never notifies the extractor.
      if (!controller.signal.aborted && round === 0 && !compact) {
        try {
          const last = [...this.store.listEvents(thread.id)].reverse().find((e) => e.event.kind === "assistant-text" && e.seq > userEvent.seq);
          const answer = last && last.event.kind === "assistant-text" ? last.event.text : "";
          if (answer) {
            // An agent that ran the harness memory_write tool saved its own notes,
            // so the extractor must not duplicate them this turn.
            const wroteMemory = this.store
              .listEvents(thread.id)
              .some((e) => e.seq > userEvent.seq && e.event.kind === "tool-use" && /memory_write$/.test(e.event.name));
            this.turnListener?.({
              projectId: thread.projectId,
              threadId: thread.id,
              agentId: thread.agent,
              model: thread.model,
              user: scrub(req.text),
              answer: scrub(answer),
              wroteMemory,
            });
          }
        } catch {
          // Background extraction is best-effort.
        }
      }
      const after = before && !controller.signal.aborted ? await dirtySet(cwd) : null;
      let checkPassed = false;
      let checkRow: { command: string; ok: boolean; tail: string } | null = null;
      let evidence: string[] = [];
      // The verification gate: only a turn that changed files runs it.
      if (checkCommand && !controller.signal.aborted && !compact) {
        // A fix round always re-checks: it exists to make the check pass.
        const changed = round > 0 || edited || !sameSet(before!, after!);
        if (changed) {
          this.emit(thread.id, { kind: "check", command: checkCommand, ok: null, exitCode: null, timedOut: false, durationMs: 0, tail: "", round });
          const r = await runCheck(checkCommand, cwd, { signal: controller.signal });
          // A stop mid-check still closes its row, so it never spins on.
          if (controller.signal.aborted) this.emit(thread.id, { kind: "check", command: checkCommand, ...r, ok: false, tail: "Stopped.", round });
          else {
            const tail = redactSecrets(r.tail, this.secrets());
            this.emit(thread.id, { kind: "check", command: checkCommand, ...r, tail, round });
            checkPassed = r.ok === true;
            checkRow = { command: checkCommand, ok: checkPassed, tail };
            if (!r.ok) {
              if (round < maxRounds) {
                followUp = {
                  threadId: thread.id,
                  // Kept small: no command (the app re-runs it) and a shorter tail than the row's.
                  text: `The project check ${r.timedOut ? "timed out" : `failed (exit ${r.exitCode})`}. Fix it, then stop; the app re-runs the check.\n\nOutput (last lines):\n\`\`\`\n${tailOf(tail, 40, 3000)}\n\`\`\``,
                  checkRound: round + 1,
                };
              } else if (maxRounds > 0) {
                this.emit(thread.id, { kind: "notice", text: `The check still fails after ${maxRounds} fix ${maxRounds === 1 ? "attempt" : "attempts"}, so it stopped. Run it yourself or ask again.` });
              }
            }
          }
        }
      }
      // The evidence gate: a notice when the turn's "done" deserves a second look.
      if (before && after && !controller.signal.aborted) {
        try {
          const last = [...this.store.listEvents(thread.id)].reverse().find((e) => e.event.kind === "assistant-text" && e.seq > userEvent.seq);
          const answer = last && last.event.kind === "assistant-text" ? last.event.text : "";
          const flags = await turnEvidence(cwd, { before, after, testsBefore, editDiffs, commands, answer, request: req.text, checkPassed });
          evidence = flags;
          if (flags.length) this.emit(thread.id, { kind: "notice", text: `Worth a second look: ${flags.join(" ")}`, evidence: flags });
        } catch {
          // Best-effort: a git hiccup never fails the turn.
        }
      }
      if (learner) {
        try {
          const last = [...this.store.listEvents(thread.id)].reverse().find((e) => e.event.kind === "assistant-text" && e.seq > userEvent.seq);
          const rel = (p: string) => (isAbsolute(p) ? relative(cwd, p) : p).replace(/\\/g, "/");
          const changed = before && after ? [...new Set([...[...after].filter((e) => !before.has(e)).map(dirtyPath), ...editDiffs.map((d) => rel(d.path))])].filter((p) => !p.startsWith("..")) : [];
          learner.afterTurn(
            {
              thread: this.store.getThread(thread.id),
              cwd,
              rootSeq,
              round,
              final: !followUp?.checkRound,
              request: scrub(req.text),
              answer: last && last.event.kind === "assistant-text" ? scrub(last.event.text) : "",
              commands,
              failedCommands,
              toolNames,
              denied,
              stopped: controller.signal.aborted,
              evidence,
              check: checkRow,
              steps: toolCalls,
              tokens: turnTokens,
              changed,
              injected: [],
            },
            pre,
          );
        } catch {
          // Scoring is best-effort and never touches the turn.
        }
      }
    } finally {
      this.running.delete(thread.id);
      // An async answer that missed the turn goes out as the next message (unless a check fix round is next).
      const late = this.afterTurn.get(thread.id);
      this.afterTurn.delete(thread.id);
      if (!followUp && late?.length) followUp = { threadId: thread.id, text: late.join("\n\n") };
      if (followUp) {
        // Re-add `running` before the renderer can drain its queued message: no
        // `running: false` between rounds, so the fix and the user's queue can't race.
        const next = followUp;
        void this.send(next).catch((e) => this.emit(thread.id, { kind: "error", message: e instanceof Error ? e.message : String(e) }));
      } else {
        this.broadcast({ type: "running", threadId: thread.id, running: false });
      }
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
   * Put an agent's questions in front of the user. Resolves "dismiss" when any
   * signal aborts (Stop, or a tool call the agent gave up on) before an answer.
   */
  private ask(threadId: string, questions: Question[], signals: AbortSignal[], async = false): Promise<QuestionAnswer> {
    return new Promise<QuestionAnswer>((resolve) => {
      const requestId = randomUUID();
      const cancel = () => {
        if (!this.pendingQuestions.delete(requestId)) return;
        this.broadcast({ type: "question-done", requestId });
        resolve("dismiss");
      };
      if (signals.some((s) => s.aborted)) return resolve("dismiss");
      this.pendingQuestions.set(requestId, { threadId, questions, async, resolve });
      for (const s of signals) s.addEventListener("abort", cancel, { once: true });
      this.broadcast({ type: "question", request: { requestId, threadId, questions, ...(async ? { async } : {}) } });
    });
  }

  /** A harness tool (ACP's ask_user) asks on behalf of a thread's running turn; null when no turn is running there. */
  askFromTool(threadId: string, questions: Question[], signal?: AbortSignal): Promise<QuestionAnswer> | null {
    const turn = this.running.get(threadId);
    if (!turn) return null;
    return this.ask(threadId, questions, signal ? [turn.signal, signal] : [turn.signal]);
  }

  /** The user answered (or skipped) an agent's questions: record it, tell the UI, and hand the answer to the agent. */
  respondQuestion(requestId: string, answer: QuestionAnswer): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return;
    this.pendingQuestions.delete(requestId);
    const skipped = answer === "dismiss";
    const items = pending.questions.map((q) => {
      const given = skipped ? [] : (answer.answers[q.id] ?? []);
      const note = skipped ? undefined : answer.notes?.[q.id];
      return {
        header: q.header,
        question: q.question,
        answer: q.secret ? given.map(() => "•••") : given.map((a) => redactSecrets(a, this.secrets())),
        ...(note && !q.secret ? { note: redactSecrets(note, this.secrets()) } : {}),
      };
    });
    this.emit(pending.threadId, { kind: "questions", items, skipped });
    this.broadcast({ type: "question-done", requestId });
    pending.resolve(answer);
    if (pending.async) void this.deliverAsync(pending.threadId, pending.questions, answer);
  }

  /**
   * An async question's answer: into the running turn if the agent can take it
   * (Codex turn/steer), else as the next message, after the turn if one is
   * still finishing. A skip with no turn running needs no message at all.
   */
  private async deliverAsync(threadId: string, questions: Question[], answer: QuestionAnswer): Promise<void> {
    const text = answersMessage(questions, answer);
    const thread = this.store.getThread(threadId);
    if (this.running.has(threadId)) {
      const steered = await this.drivers.get(thread.agent)?.steer?.(threadId, text).catch(() => false);
      if (steered) return;
      if (this.running.has(threadId)) {
        this.afterTurn.set(threadId, [...(this.afterTurn.get(threadId) ?? []), text]);
        return;
      }
    }
    if (answer === "dismiss") return;
    await this.send({ threadId, text }).catch((e) => this.emit(threadId, { kind: "error", message: e instanceof Error ? e.message : String(e) }));
  }

  /** Everything open right now, so a reloaded window shows running threads and their cards again. */
  pendingState(): PendingState {
    return {
      running: [...this.running.keys()],
      permissions: [...this.permissionRequests.values()],
      plans: [...this.planRequests.values()],
      questions: [...this.pendingQuestions.entries()].map(([requestId, q]) => ({ requestId, threadId: q.threadId, questions: q.questions, ...(q.async ? { async: true } : {}) })),
    };
  }

  /** The user answered a plan proposal: record it, tell the UI, and follow the chosen mode. */
  respondPlan(requestId: string, decision: PlanDecision): void {
    const pending = this.pendingPlans.get(requestId);
    if (!pending) return;
    this.pendingPlans.delete(requestId);
    this.planRequests.delete(requestId);
    const choice = decision === "auto" ? "auto" : decision === "manual" ? "manual" : "keep";
    const feedback = typeof decision === "object" ? decision.keep.trim() : "";
    this.emit(pending.threadId, { kind: "plan-decision", choice, ...(choice === "keep" && feedback ? { feedback } : {}) });
    this.broadcast({ type: "plan-approval-done", requestId });
    if (decision === "auto" || decision === "manual") {
      const permissionMode: PermissionMode = decision === "auto" ? "auto-edit" : "ask";
      this.broadcast({ type: "thread", thread: this.store.updateThread(pending.threadId, { permissionMode }) });
    }
    pending.resolve(decision);
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
      this.pendingCatchUp.set(threadId, { afterSeq: 0 });
    }
    const models = driver.models();
    const label = (id: string) => models.find((m) => m.id === id)?.label ?? id;
    const text =
      result === "in-place"
        ? `Switched the model from ${label(from)} to ${label(to)}. ${driver.label} keeps the conversation, but the prompt cache starts over, so the next reply may be slower and cost more.`
        : `Switched the model from ${label(from)} to ${label(to)}. ${driver.label} starts a new session for this switch; the conversation so far is handed over with your next message.`;
    this.emit(threadId, { kind: "notice", text });
    return result;
  }

  /**
   * The model the agent's last turn actually started with: the newest turn-start
   * event's model. Later events (a notice or a stop stored after the user picks
   * in the model picker) carry the model picked since, so they can't say what
   * the session was running. An agent with no turn-start on record falls back to
   * its newest provenance, which is all such a driver ever wrote.
   */
  private lastModel(threadId: string, agent: string): string | null {
    const events = this.store.listEvents(threadId);
    let fallback: string | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const { event, provenance } = events[i]!;
      // The model that turn was asked for, not the id the API resolved it to (Claude reports `claude-sonnet-5-5`
      // for `default`), so an unchanged pick never reads as a switch.
      if (event.kind === "turn-start" && (provenance?.agent === agent || event.agent === agent)) return provenance?.model ?? event.model;
      if (fallback === null && provenance?.agent === agent) fallback = provenance.model;
    }
    return fallback;
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

  /** Wire the artifact panel's storage and preview; without it, turns record no artifacts. */
  setArtifacts(deps: ArtifactDeps): void {
    this.artifacts = deps;
  }

  /**
   * Save a version of each file the turn edited or wrote, then tell the renderer which
   * one to open: the last file of a kind that opens by itself (not markdown or
   * code), never mid-stream. Never throws.
   */
  private recordArtifacts(threadId: string, root: string, turnSeq: number, turnStartedAt: number): void {
    if (!this.artifacts) return;
    try {
      // Another design thread in this project may be writing its own folder at the same time: not this turn's work.
      const thread = this.store.getThread(threadId);
      const skipDirs = this.store
        .listThreads(thread.projectId)
        .filter((t) => t.id !== threadId)
        .flatMap((t) => designOf(t) ?? []);
      const { files } = recordTurnArtifacts(this.artifacts, { threadId, root, events: this.store.listEvents(threadId), turnSeq, turnStartedAt, skipDirs });
      const path = files.filter(opensByItself).at(-1);
      if (path) this.broadcast({ type: "artifact-ready", threadId, path, files });
    } catch (err) {
      console.warn("artifact recording failed", err);
    }
  }

  /** The folder a thread's tools run in: its worktree, else its project. */
  threadFolder(threadId: string): string {
    const thread = this.store.getThread(threadId);
    return this.folderOf(thread.projectId, threadId);
  }

  /** A design thread's folder, absolute; null for any other thread (the canvas serves nothing for it). */
  designRoot(threadId: string): string | null {
    const thread = this.store.getThread(threadId);
    const dir = designOf(thread);
    return dir ? join(this.threadFolder(threadId), dir) : null;
  }

  /** Where the built-in design systems live; without it a design thread gets only its project's own. */
  setDesignSystemsDir(dir: string): void {
    this.designSystemsDir = dir;
  }

  /** The design systems a project's design threads can use, for the composer's picker. */
  designSystems(projectId: string | null): DesignSystemOption[] {
    return listDesignSystems(this.projectPath(projectId), this.designSystemsDir ?? "").map(({ id, name, description, swatches, source }) => ({
      id,
      name,
      description,
      swatches,
      source,
    }));
  }

  /** A design thread's resolved system with its files, or null (not a design thread, or no system at all). */
  private threadSystem(thread: Thread): DesignSystemInfo | null {
    if (thread.kind !== "design") return null;
    return resolveDesignSystem(listDesignSystems(this.projectPath(thread.projectId), this.designSystemsDir ?? ""), thread.designSystem);
  }

  /** The System tab's view of a system: DESIGN.md and its tokens, plus whether (and how) it can be edited. */
  private systemDoc(thread: Thread, system: DesignSystemInfo): DesignSystemDoc {
    const project = this.projectPath(thread.projectId);
    const read = (file: string | undefined): string => {
      if (!file) return "";
      try {
        return readFileSync(file, "utf8");
      } catch {
        return "";
      }
    };
    return {
      id: system.id,
      name: system.name,
      source: system.source,
      editable: system.source !== "builtin" || project !== null,
      copyOnWrite: system.source === "builtin",
      designMd: read(system.designMd),
      groups: parseTokens(read(system.tokensCss)),
    };
  }

  /** The thread's design system for the canvas's System tab; null for any other thread. */
  designSystemDoc(threadId: string): DesignSystemDoc | null {
    const thread = this.store.getThread(threadId);
    const system = this.threadSystem(thread);
    return system ? this.systemDoc(thread, system) : null;
  }

  /**
   * Edit a design thread's system from the System tab. A built-in is copied into the project's
   * `.agents/design-systems/<id>-custom/` first and the thread switched to the copy. The result is copied into the design
   * folder right away, so the canvas reloads with it; the marker moves too, so the next turn doesn't announce a switch.
   */
  editDesignSystem(threadId: string, edit: DesignSystemEdit): { doc: DesignSystemDoc; thread: Thread } {
    let thread = this.store.getThread(threadId);
    let system = this.threadSystem(thread);
    if (!system) throw new Error("Only a design thread has a design system.");
    if (system.source === "builtin") {
      const project = this.projectPath(thread.projectId);
      if (!project) throw new Error("Open a project folder to customize a built-in design system.");
      system = forkSystem(system, project);
      thread = this.store.setDesignSystem(threadId, system.id);
    }
    if ("token" in edit) {
      if (!system.tokensCss) throw new Error("This design system has no tokens.css.");
      const { name, scheme, value } = edit.token;
      writeFileSync(system.tokensCss, setToken(readFileSync(system.tokensCss, "utf8"), name, scheme, value));
    } else {
      writeFileSync(system.designMd, edit.designMd);
    }
    const root = this.designRoot(threadId);
    if (root) materializeSystem(system, join(root, "system"));
    return { doc: this.systemDoc(thread, system), thread };
  }

  /** Pick a design thread's system (null = the default); the next turn copies it in and tells the agent. */
  setDesignSystem(threadId: string, id: string | null): Thread {
    const thread = this.store.getThread(threadId);
    if (thread.kind !== "design") throw new Error("Only a design thread has a design system.");
    return this.store.setDesignSystem(threadId, id);
  }

  /**
   * Set the expert on a thread that has no messages yet (the user summoned it there). A thread that has run keeps the
   * expert it started with, so its prompt-cache prefix never changes mid-conversation.
   */
  setThreadExpert(threadId: string, expertId: string | null): Thread {
    if (this.store.listEvents(threadId).length > 0) throw new Error("This thread already has messages; start a new thread with the expert.");
    return this.store.setExpert(threadId, expertId);
  }

  /** Pick a design thread's prototype tier (null = Working); the next turn tells the agent, once. */
  setPrototypeTier(threadId: string, tier: PrototypeTier | null): Thread {
    const thread = this.store.getThread(threadId);
    if (thread.kind !== "design") throw new Error("Only a design thread has a prototype tier.");
    return this.store.setPrototypeTier(threadId, tier);
  }

  /**
   * The tier's instructions for this turn: said on a design thread's first
   * turn and again after a switch, never otherwise (a `.tier` marker in the
   * design folder remembers the last one said), so the guide stays stable.
   */
  private prepareDesignTier(thread: Thread): string {
    const root = this.designRoot(thread.id);
    if (!root) return "";
    const tier = tierOf(thread);
    const marker = join(root, ".tier");
    let said = "";
    try {
      said = readFileSync(marker, "utf8").trim();
    } catch {
      // First turn: nothing said yet.
    }
    if (said === tier) return "";
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(marker, tier);
    } catch {
      // Unwritable folder: say it this turn anyway.
    }
    return `\n\n(CubiQ: ${tierNote(tier)})`;
  }

  /**
   * Copy a design thread's system into `<design folder>/system/` when it's
   * missing or changed (the canvas can only load files from that folder, and the
   * guide always names the same place, so switching never changes the guide).
   * Returns the line that tells the agent about a switch, once; "" otherwise.
   */
  private prepareDesignSystem(thread: Thread): string {
    const root = this.designRoot(thread.id);
    if (!root) return "";
    try {
      const system = resolveDesignSystem(listDesignSystems(this.projectPath(thread.projectId), this.designSystemsDir ?? ""), thread.designSystem);
      if (!system) return "";
      const dir = join(root, "system");
      let before = "";
      try {
        before = readFileSync(join(dir, ".system"), "utf8").trim();
      } catch {
        // First turn: nothing there yet.
      }
      materializeSystem(system, dir);
      return before && before !== system.id
        ? `\n\n(CubiQ: the design system is now ${system.name}; \`${designOf(thread)}/system/\` was replaced. Read its DESIGN.md and restyle with its tokens.)`
        : "";
    } catch {
      // A failed copy leaves the last system in place; never fail the turn over it.
      return "";
    }
  }

  /**
   * Save a design critique (design_critique_save) as the next version of the
   * thread's Critique artifact and tell the renderer; unchanged text adds none.
   */
  saveCritique(threadId: string, markdown: string): { version: number } | null {
    const thread = this.store.getThread(threadId);
    if (thread.kind !== "design") throw new Error("Only a design thread has a critique.");
    if (!this.artifacts) throw new Error("Artifacts are off.");
    const saved = recordPseudo(this.artifacts, CRITIQUE_ARTIFACT, { threadId, text: markdown, turnSeq: this.store.lastSeq(threadId) });
    if (saved) this.broadcast({ type: "artifact-ready", threadId, path: CRITIQUE_ARTIFACT, files: [CRITIQUE_ARTIFACT] });
    return saved ? { version: saved.version } : null;
  }

  /**
   * Make a variant (`variant-*.html`) the design's `index.html`. The old and new
   * index are both saved as versions first and after, so the switch can be undone
   * from the canvas's version menu.
   */
  promoteDesignVariant(threadId: string, rel: string): void {
    const thread = this.store.getThread(threadId);
    const root = this.designRoot(threadId);
    const dir = designOf(thread);
    if (!root || !dir) throw new Error("Only a design thread has variants.");
    promoteVariant(root, rel, (page) => this.recordDesignPage(threadId, root, dir, page));
    if (this.artifacts) this.broadcast({ type: "artifact-ready", threadId, path: `${dir}/index.html`, files: [`${dir}/index.html`] });
  }

  /**
   * Write the canvas's tweak values into a design page (Keep): its manifest
   * defaults, `<html>` attributes and vars block. Saved as versions before and
   * after; false when nothing changed.
   */
  keepDesignTweaks(threadId: string, rel: string, values: TweakValues): boolean {
    const thread = this.store.getThread(threadId);
    const root = this.designRoot(threadId);
    const dir = designOf(thread);
    if (!root || !dir) throw new Error("Only a design thread has tweaks.");
    if (!listDesignPages(root).includes(rel)) throw new Error("No such page.");
    const file = join(root, rel);
    const before = readFileSync(file, "utf8");
    const after = keepTweaks(before, values);
    if (after === before) return false;
    this.recordDesignPage(threadId, root, dir, rel);
    writeFileSync(file, after);
    this.recordDesignPage(threadId, root, dir, rel);
    if (this.artifacts) this.broadcast({ type: "artifact-ready", threadId, path: `${dir}/${rel}`, files: [`${dir}/${rel}`] });
    return true;
  }

  /**
   * Save a pasted reference image into a design thread's `refs/` folder; the
   * path relative to the thread's folder, ready to mention.
   */
  saveDesignRef(threadId: string, bytes: Uint8Array): string {
    const thread = this.store.getThread(threadId);
    const root = this.designRoot(threadId);
    const dir = designOf(thread);
    if (!root || !dir) throw new Error("Only a design thread takes reference images.");
    return `${dir}/${saveRef(root, bytes)}`;
  }

  /**
   * Write an in-place text edit from the canvas into a design page: only when
   * exactly one element has that `data-agent-id`, it holds only text, and its
   * text is still `before` (else the refusal says to ask the agent). Saved as
   * versions before and after.
   */
  editDesignText(threadId: string, rel: string, edit: { id: string; before: string; after: string }): void {
    const thread = this.store.getThread(threadId);
    const root = this.designRoot(threadId);
    const dir = designOf(thread);
    if (!root || !dir) throw new Error("Only a design thread has pages to edit.");
    if (!listDesignPages(root).includes(rel)) throw new Error("No such page.");
    const file = join(root, rel);
    const before = readFileSync(file, "utf8");
    const after = applyTextEdit(before, edit.id, edit.before, edit.after);
    if (after === before) return;
    this.recordDesignPage(threadId, root, dir, rel);
    writeFileSync(file, after);
    this.recordDesignPage(threadId, root, dir, rel);
    if (this.artifacts) this.broadcast({ type: "artifact-ready", threadId, path: `${dir}/${rel}`, files: [`${dir}/${rel}`] });
  }

  /**
   * Write the inspector's style changes into a design page: into the `style` attribute of the one element with that
   * `data-agent-id` (see applyStyleEdit). Working and Real app tiers only; on Quick the change goes to the agent as a
   * message instead. Saved as versions before and after, like a text edit.
   */
  editDesignStyle(threadId: string, rel: string, edit: { id: string; changes: { prop: string; value: string }[] }): void {
    const thread = this.store.getThread(threadId);
    const root = this.designRoot(threadId);
    const dir = designOf(thread);
    if (!root || !dir) throw new Error("Only a design thread has pages to edit.");
    if (!tierFeatures(tierOf(thread)).textEdit) throw new Error("The Quick tier sends style changes to the agent.");
    if (!listDesignPages(root).includes(rel)) throw new Error("No such page.");
    const file = join(root, rel);
    const before = readFileSync(file, "utf8");
    const after = applyStyleEdit(before, edit.id, edit.changes);
    if (after === before) return;
    this.recordDesignPage(threadId, root, dir, rel);
    writeFileSync(file, after);
    this.recordDesignPage(threadId, root, dir, rel);
    if (this.artifacts) this.broadcast({ type: "artifact-ready", threadId, path: `${dir}/${rel}`, files: [`${dir}/${rel}`] });
  }

  /**
   * Restore a stored version of a design page as its newest: the page as it is
   * now is saved as a version first, then version N is written back and saved
   * again, so nothing is overwritten and the restore itself can be undone.
   */
  restoreDesignVersion(threadId: string, rel: string, version: number): void {
    const thread = this.store.getThread(threadId);
    const root = this.designRoot(threadId);
    const dir = designOf(thread);
    if (!root || !dir) throw new Error("Only a design thread has versions to restore.");
    if (!listDesignPages(root).includes(rel)) throw new Error("No such page.");
    const buf = this.readDesignVersion(threadId, rel, version);
    if (!buf) throw new Error(`No version ${version} of this page.`);
    const file = join(root, rel);
    this.recordDesignPage(threadId, root, dir, rel);
    writeFileSync(file, buf);
    this.recordDesignPage(threadId, root, dir, rel);
    if (this.artifacts) this.broadcast({ type: "artifact-ready", threadId, path: `${dir}/${rel}`, files: [`${dir}/${rel}`] });
  }

  /** A design thread's folder, or an error for any other thread. */
  private designRootOf(threadId: string, what: string): string {
    const root = this.designRoot(threadId);
    if (!root) throw new Error(`Only a design thread has ${what}.`);
    return root;
  }

  /** A design thread's comments (kept in its design folder as comments.json). */
  designComments(threadId: string): DesignComment[] {
    return loadComments(this.designRootOf(threadId, "comments"));
  }

  /** Add a comment on an element of a design page; the full list after. */
  addDesignComment(threadId: string, input: { page: string; target: CommentTarget; label: string; text: string }): DesignComment[] {
    const root = this.designRootOf(threadId, "comments");
    if (!listDesignPages(root).includes(input.page)) throw new Error("No such page.");
    const list = addComment(loadComments(root), input);
    saveComments(root, list);
    return list;
  }

  /** Resolve, reopen or mark sent one of a design thread's comments; the full list after. */
  updateDesignComment(threadId: string, id: string, patch: { resolved?: boolean; sent?: boolean }): DesignComment[] {
    const root = this.designRootOf(threadId, "comments");
    const list = updateComment(loadComments(root), id, patch);
    saveComments(root, list);
    return list;
  }

  /** Delete one of a design thread's comments; the full list after. */
  deleteDesignComment(threadId: string, id: string): DesignComment[] {
    const root = this.designRootOf(threadId, "comments");
    const list = deleteComment(loadComments(root), id);
    saveComments(root, list);
    return list;
  }

  /** Save a design page as it is on disk as the next version (unchanged content adds none). */
  private recordDesignPage(threadId: string, root: string, dir: string, rel: string): void {
    if (!this.artifacts) return;
    const buf = readFileSync(join(root, rel));
    const sha256 = createHash("sha256").update(buf).digest("hex");
    this.artifacts.writeBlob(sha256, buf);
    this.artifacts.addVersion(threadId, `${dir}/${rel}`, sha256, buf.length, this.store.lastSeq(threadId));
  }

  /** A stored turn-end version of a file in a design thread's folder (`rel` is inside that folder). */
  readDesignVersion(threadId: string, rel: string, version: number): Buffer | null {
    const dir = designOf(this.store.getThread(threadId));
    if (!dir || !this.artifacts) return null;
    const entry = this.artifacts.listVersions(threadId).find((v) => v.path === `${dir}/${rel}`)?.versions.find((v) => v.version === version);
    return entry ? this.artifacts.readBlob(entry.sha256) : null;
  }

  listArtifacts(threadId: string): ArtifactFile[] {
    return this.artifacts ? listArtifacts(this.artifacts, threadId) : [];
  }

  readArtifact(threadId: string, path: string, version?: number | null): Promise<ArtifactContent> {
    if (!this.artifacts) return Promise.resolve({ ok: false, error: "Previews are off" });
    return readArtifact(this.artifacts, { threadId, root: this.threadFolder(threadId), path, version });
  }

  artifactDiff(threadId: string, path: string, version?: number | null): Promise<string | null> {
    if (!this.artifacts) return Promise.resolve(null);
    return artifactDiff(this.artifacts, { threadId, root: this.threadFolder(threadId), path, version });
  }

  getDiff(projectId: string, threadId?: string | null): Promise<DiffFile[]> {
    return workingTreeDiff(this.folderOf(projectId, threadId));
  }

  listFiles(projectId: string, threadId?: string | null): Promise<{ files: string[]; truncated: boolean }> {
    return listProjectFiles(this.folderOf(projectId, threadId));
  }

  /** The folder the Changes and Files tabs show: the open thread's worktree, else the project. */
  private folderOf(projectId: string, threadId?: string | null): string {
    if (threadId) {
      const thread = this.store.getThread(threadId);
      if (thread.projectId === projectId && thread.worktreePath) return thread.worktreePath;
    }
    return this.store.getProject(projectId).path;
  }

  projectBranch(projectId: string): Promise<string | null> {
    return branchLabel(this.store.getProject(projectId).path);
  }
}

/** A design thread's folder relative to its working folder, else undefined. */
function designOf(thread: Thread): string | undefined {
  return thread.kind === "design" ? designDirName(thread.id) : undefined;
}

function formatK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * The working tree's changed paths with each one's mtime and size, or an empty
 * set outside git or when the read fails. The stamps catch a second edit to a
 * file that was already dirty, which the path list alone can't see.
 */
async function dirtySet(cwd: string): Promise<Set<string>> {
  try {
    // One git call, and none outside a repository: this runs before every turn.
    if (!hasGitDir(cwd)) return new Set();
    const out = new Set<string>();
    for (const path of (await dirtyPaths(cwd)).slice(0, 500)) {
      try {
        const st = statSync(join(cwd, path));
        out.add(`${path}|${st.mtimeMs}|${st.size}`);
      } catch {
        out.add(`${path}|gone`);
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

/** The path of a dirtySet entry ("path|mtime|size" or "path|gone"). */
function dirtyPath(entry: string): string {
  return entry.replace(/\|(?:gone|[\d.]+\|\d+)$/, "");
}

/** The diffs in an Edit tool-result payload ({ diff: [{ path, unified }] }), if any. */
function diffsOf(payload: unknown): { path: string; unified: string }[] {
  const diff = (payload as { diff?: unknown } | undefined)?.diff;
  if (!Array.isArray(diff)) return [];
  return diff.filter((d): d is { path: string; unified: string } => typeof d?.path === "string" && typeof d?.unified === "string");
}

/** Skip/only/trivial-assert counts in each test file's changes against HEAD (at most 20 files). */
async function testMarkersOf(cwd: string, paths: string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  for (const p of paths.slice(0, 20)) out.set(p, markerCounts(await addedSinceHead(cwd, p)));
  return out;
}

/** The evidence-gate flags for a finished turn, from the working tree before and after it. */
async function turnEvidence(
  cwd: string,
  t: {
    before: Set<string>;
    after: Set<string>;
    testsBefore: Map<string, Map<string, number>>;
    editDiffs: { path: string; unified: string }[];
    commands: string[];
    answer: string;
    request: string;
    checkPassed: boolean;
  },
): Promise<string[]> {
  const rel = (p: string) => (isAbsolute(p) ? relative(cwd, p) : p).replace(/\\/g, "/");
  const byPath = new Map<string, string[]>();
  for (const d of t.editDiffs) {
    const p = rel(d.path);
    if (!p.startsWith("..") && isTestPath(p)) byPath.set(p, [...(byPath.get(p) ?? []), ...diffAddedLines(d.unified)]);
  }
  const beforePaths = new Set([...t.before].map(dirtyPath));
  const changed = new Set([...t.after].filter((e) => !t.before.has(e)).map(dirtyPath).filter(isTestPath));
  for (const p of byPath.keys()) changed.add(p);
  const deletedTests: string[] = [];
  const editedTests: string[] = [];
  const weakened: { path: string; labels: string[] }[] = [];
  for (const p of [...changed].slice(0, 20)) {
    if (t.after.has(`${p}|gone`)) {
      deletedTests.push(p);
      continue;
    }
    if (beforePaths.has(p) || (await isTracked(cwd, p))) editedTests.push(p);
    // An Edit's own diff is exactly this turn's lines; otherwise compare against HEAD, before and after.
    const lines = byPath.get(p);
    const labels = lines ? newMarkers(new Map(), markerCounts(lines)) : newMarkers(t.testsBefore.get(p) ?? new Map(), markerCounts(await addedSinceHead(cwd, p)));
    if (labels.length) weakened.push({ path: p, labels });
  }
  return evidenceFlags({ editedTests, deletedTests, weakened, request: t.request, answer: t.answer, commands: t.commands, checkPassed: t.checkPassed });
}

/** Whether two sets hold the same members. */
function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function titleFrom(text: string, skillNames?: string | readonly string[]): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  const skills = typeof skillNames === "string" ? [skillNames] : [...new Set(skillNames ?? [])];
  const prefix = skills.map((s) => `/${s}`).join(" ");
  const base = firstLine || "New thread";
  const withSkill = prefix ? (firstLine ? `${prefix} ${firstLine}` : prefix) : base;
  return withSkill.length > 60 ? `${withSkill.slice(0, 59)}…` : withSkill;
}
