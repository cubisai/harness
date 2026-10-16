import type { ZodRawShape, z } from "zod";
import type { AgentCapabilities, AgentCredentials, AgentInfo, LiveDelta, McpServerEntry, ModelOption, PermissionDecision, PermissionMode, PlanDecision, Provenance, Question, QuestionAnswer, SkillsDelivery, ThreadEvent } from "../../shared/types";
import type { LimitsPatch } from "./limits";
import type { TeamAgent } from "../../shared/experts";

export type { AgentCapabilities, SkillsDelivery } from "../../shared/types";

/** How a driver takes a model change on an existing session. */
export type ModelSwitch = "in-place" | "new-session";

export interface ToolOutput {
  text: string;
  /** A PNG the model should see, base64. */
  imagePng?: string;
  isError?: boolean;
}

/** Who is calling a harness tool, when the transport knows (the HTTP tool server does). */
export interface ToolContext {
  projectId?: string;
  /** The thread whose turn called the tool, when the tool server knows it (`?t=`). */
  threadId?: string;
  /** Aborts when the caller gives up on the call (the HTTP request closed). */
  signal?: AbortSignal;
}

/**
 * A tool the harness itself provides to the agent (the browser pane's tools,
 * for one). Drivers expose these however their agent takes tools: an
 * in-process MCP server for Claude.
 */
export interface HarnessTool<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  input: Shape;
  /** Safe to run without asking in "ask" mode. */
  autoAllow: boolean;
  run(args: z.infer<z.ZodObject<Shape>>, ctx?: ToolContext): Promise<ToolOutput>;
}

/** How a new session catches up when the stored one is gone: Codex takes history items, first-message agents a prompt prefix. */
export type SessionSeed = { inject: (sessionId: string, send: (items: unknown[]) => Promise<void>) => Promise<void> } | { promptPrefix: string };

/** What a driver needs for one turn. */
export interface TurnInput {
  threadId: string;
  cwd: string;
  /** The thread's project, for per-project features (shared memory); absent in some tests. */
  projectId?: string;
  /** A design thread's folder (relative to cwd), which the guide tells the agent to build in. */
  design?: string;
  /** The thread's expert persona block (see shared/experts.ts expertBlock), appended to the guide; absent = no expert. */
  expert?: string;
  /** The expert team's members as subagents (Claude SDK agents, OpenCode agents); absent = no team. Fixed for a thread. */
  team?: TeamAgent[];
  /** The folder holding the thread's expert's private package skills (read-only for the agent); absent = none. */
  expertRoot?: string;
  prompt: string;
  /** Compact the session instead of prompting (/compact); the focus steers the summary where the agent supports it. */
  compact?: { focus: string | null };
  /** The agent's session to resume, or null for a new conversation. */
  sessionId: string | null;
  model: string;
  /** Reasoning effort for this turn; null or absent keeps the model's default. */
  effort?: string | null;
  /** Context-window override for this turn; null/absent keeps the model's default. */
  contextWindow?: number | null;
  permissionMode: PermissionMode;
  signal: AbortSignal;
  onEvent(event: ThreadEvent): void;
  /**
   * Live assistant text; itemId keys the live item so the renderer clears it only when that item's terminal event lands.
   * parentId (here and on reasoning/tool output) = the Agent call a subagent's delta streams under.
   */
  onTextDelta(text: string, itemId?: string, parentId?: string): void;
  /** Live reasoning text for one thinking item. */
  onReasoningDelta?(d: { itemId: string; text: string; opaque: boolean; parentId?: string }): void;
  /** Latest summary for one reasoning item. */
  onReasoningSummary?(d: { itemId: string; index: number; text: string }): void;
  /** Tool input JSON as it streams. */
  onToolInputDelta?(d: { toolUseId: string; text: string }): void;
  /** Tool output as it streams. */
  onToolOutputDelta?(d: { toolUseId: string; text: string; parentId?: string }): void;
  /** Rolling token usage for the turn. */
  onUsageUpdate?(u: Omit<Extract<LiveDelta, { kind: "usage-update" }>, "kind">): void;
  /** Estimated thinking tokens for the in-progress block. */
  onThinkingProgress?(p: { estimatedTokens: number }): void;
  onSession(sessionId: string): void;
  /** The driver reopened the session this turn (an MCP server change), so the prompt cache starts over; an expected rebuild, not a miss. */
  onSessionRebuilt?(): void;
  /** The stored session couldn't be reopened (reason is the agent's own error). The driver starts a new session and applies the returned seed; null means start without history. */
  onSessionLost?(reason: string): Promise<SessionSeed | null>;
  requestPermission(req: { toolName: string; summary: string; canAlwaysAllow: boolean }): Promise<PermissionDecision>;
  /** Plan mode: the agent presented a plan and waits for the user's decision. */
  requestPlanDecision(p: { plan: string }): Promise<PlanDecision>;
  /** The agent asks the user questions (Claude's AskUserQuestion, Codex's request_user_input); resolves "dismiss" when skipped or stopped. Absent: the driver answers "dismiss". */
  requestUserInput?(questions: Question[], opts?: { async?: boolean }): Promise<QuestionAnswer>;
  /** Harness-provided tools for this turn; empty when none apply. */
  tools: HarnessTool[];
  /** The user's MCP servers (mcp.json), passed to the agent alongside its own. */
  mcpServers: McpServerEntry[];
  /** Who is running this turn, for the events it produces. */
  provenance?: Provenance;
  /** Self-improve S6: the native agent may add one short corrective note mid-turn (a repeated failing command, an unbacked "tests pass"). Other drivers ignore it. */
  nudges?: boolean;
}

/** What a driver needs to seed a new session with a handoff, without starting a turn. */
export interface SeedRequest {
  threadId: string;
  /** The target's existing cursor, resumed when it still works; null opens a new session. */
  sessionId: string | null;
  cwd: string;
  /** The thread's project, for per-project features (shared memory); absent in some tests. */
  projectId?: string;
  /** A design thread's folder (relative to cwd), as in `TurnInput`. */
  design?: string;
  /** The thread's expert persona block (see shared/experts.ts expertBlock), appended to the guide; absent = no expert. */
  expert?: string;
  /** The folder holding the thread's expert's private package skills (read-only for the agent); absent = none. */
  expertRoot?: string;
  model: string;
  permissionMode: PermissionMode;
  tools: HarnessTool[];
  mcpServers: McpServerEntry[];
  /** Responses-shaped history items for inject-items channels. */
  items: unknown[];
  onSession(sessionId: string): void;
  /** Sends through the injection ledger for this target session; returns what was actually sent. */
  inject(sessionId: string, send: (items: unknown[]) => Promise<void>): Promise<{ sent: number; skipped: number }>;
}

export interface SeedResult { mode: "resume" | "seeded" | "unsupported"; reason?: string; sessionId?: string; sent?: number }

/**
 * One agent backend. Milestone 1 ships Claude (Agent SDK); Codex
 * (app-server) and ACP agents (OpenCode, Antigravity, Cursor)
 * implement the same interface next.
 */
export interface AgentDriver {
  id: string;
  label: string;
  models(): ModelOption[];
  defaultModel: string;
  /** What this agent can do here, so callers branch on capability, not id. */
  capabilities: AgentCapabilities;
  /** How Settings offers providers for it. */
  credentials?: AgentCredentials;
  /** Reached only unofficially: shown as "Unsupported · <this>". */
  unsupported?: string;
  /** How this agent's model-invoked skills reach it (and the Skill-call prefix). */
  skillsDelivery: SkillsDelivery;
  /**
   * How this agent names skilled's skills in a Skill-tool call: "skilled:"
   * for Claude, which loads them as a plugin; "" for agents that load them
   * by bare name.
   * @deprecated use `skillsDelivery.prefix ?? ""`.
   */
  skillCallPrefix: string;
  /**
   * Ask the agent for its model list without running a turn, so the picker
   * is filled at startup. Resolves when models() may have grown; failures
   * leave the list as it was. Concurrent callers share one attempt.
   * `force` skips the list's TTL (after a provider or credential change).
   */
  refreshModels?(opts?: { force?: boolean }): Promise<void>;
  /**
   * Ask the agent for its plan rate limits without running a turn. Resolves
   * with a patch, with "unsupported" when this login has no plan limits, or
   * with null when there's nothing to ask right now (e.g. no running
   * process); a rejection is a failure the caller may retry with back-off.
   */
  readLimits?(): Promise<LimitsPatch | "unsupported" | null>;
  /**
   * How this agent takes a model change on an existing session. Every switch
   * invalidates the prompt cache (each model has its own).
   */
  setModel?(req: { threadId: string; sessionId: string; from: string; to: string }): Promise<ModelSwitch>;
  /** Add the user's words to the thread's running turn (Codex turn/steer); false when no turn of this thread is running. */
  steer?(threadId: string, text: string): Promise<boolean>;
  /** Count tokens in the target model's own tokenizer, when the agent offers a free way to. Absent: the harness estimates. */
  countTokens?(text: string, model: string): Promise<number>;
  /** The CLI copy this agent actually runs, and the other copies found, when the driver knows. */
  binary?(): AgentInfo["binary"];
  /** Seed a session with a handoff without starting a turn (inject-items channels only). */
  seed?(req: SeedRequest): Promise<SeedResult>;
  /**
   * One hidden prompt with no tools and no thread events, for background work
   * (memory extraction). Resolves to the final assistant text. Absent = unsupported.
   */
  oneShot?(req: { prompt: string; model: string | null; effort?: string | null; signal?: AbortSignal }): Promise<string>;
  runTurn(input: TurnInput): Promise<void>;
  /** Stop any agent processes the driver keeps alive. */
  dispose?(): void;
}
