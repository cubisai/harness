import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessTool, ToolOutput } from "../agents/types";
import { isChatsRoot } from "../chats";
import { type ProposalScope, validateProposal } from "../extensions/manifest";
import type { ExtensionStore } from "../extensions/store";
import type { Catalog } from "../skills/catalog";
import { discoverSkills } from "../skills/discover";
import type { McpOverview, McpServerView, Project, Thread } from "../../shared/types";

export const CREATOR_INSPECT_TOOL = "creator_inspect";
export const CREATOR_PROPOSE_TOOL = "creator_propose";

/** Cap on active (staged) proposals one thread can accumulate without review. */
export const MAX_STAGED_PER_THREAD = 5;

export interface CreatorToolsDeps {
  creatorDir: string;
  bundledSkillsDir: string;
  chatsRoot: string | null;
  threadOf: (threadId: string) => Thread | null;
  projectOf: (projectId: string) => Project | null;
  cwdOf: (thread: Thread) => string;
  skillsForProject: (cwd: string | null) => Catalog;
  mcpOverview: (projectId: string | null) => McpOverview;
  extensions: ExtensionStore;
  emitProposal: (threadId: string, proposalId: string) => void;
  limitPerThread?: number;
}

function define<S extends z.ZodRawShape>(t: HarnessTool<S>): HarnessTool {
  return t as unknown as HarnessTool;
}

const error = (text: string): ToolOutput => ({ text, isError: true });

const DOC_TOPICS = new Set(["overview", "skill-format", "connector-format"]);

// Zod schemas: avoid z.record (use z.object({}).catchall(z.string())) so Claude SDK tools/list never drops tools.
const stringMapSchema = z.object({}).catchall(z.string());

function summarizeServer(s: McpServerView) {
  return {
    name: s.name,
    type: s.type,
    target: s.target,
    enabled: s.enabled,
    envKeys: s.envKeys,
    headerKeys: s.headerKeys,
    ...(s.oauth ? { oauth: true } : {}),
    ...(s.locked ? { locked: true } : {}),
  };
}

/** Creator-only tools attached to Creator preset threads (`creator_inspect`, `creator_propose`). */
export function creatorTools(deps: CreatorToolsDeps, threadId: string): HarnessTool[] {
  const bundledNames = (): string[] =>
    discoverSkills({ origin: "bundled", dir: deps.bundledSkillsDir })
      .map((s) => s.name)
      .sort();

  const limit = deps.limitPerThread ?? MAX_STAGED_PER_THREAD;

  return [
    define({
      name: CREATOR_INSPECT_TOOL,
      description: "Read Creator mode docs (overview, skill-format, connector-format) or inspect installed skills and connectors.",
      input: {
        topic: z.enum(["overview", "skill-format", "connector-format", "installed"]),
      },
      autoAllow: true,
      effect: "read",
      summarize: (a) => String(a.topic ?? ""),
      run: async (args) => {
        if (DOC_TOPICS.has(args.topic)) {
          const file = join(deps.creatorDir, `${args.topic}.md`);
          if (!existsSync(file)) return error(`Creator reference doc not found: ${args.topic}.md`);
          return { text: readFileSync(file, "utf-8") };
        }
        const thread = deps.threadOf(threadId);
        if (!thread) return error("Thread not found.");
        const project = deps.projectOf(thread.projectId);
        const chatsThread = project ? isChatsRoot(project.path, deps.chatsRoot) : true;
        const effectiveProjectId = chatsThread || !project ? null : project.id;
        const cwd = effectiveProjectId ? deps.cwdOf(thread) : null;
        const catalog = deps.skillsForProject(cwd);
        const mcp = deps.mcpOverview(effectiveProjectId);
        const proposals = deps.extensions.forThread(threadId);
        return {
          text: JSON.stringify(
            {
              threadId,
              projectId: effectiveProjectId,
              availableScopes: effectiveProjectId ? ["project", "global"] : ["global"],
              bundledReservedSkills: bundledNames(),
              skills: catalog.skills.map((s) => ({
                name: s.name,
                origin: s.origin ?? "legacy",
                invocation: s.invocation,
                ...(s.mode ? { mode: s.mode } : {}),
                description: s.description,
              })),
              connectors: {
                global: mcp.servers.map(summarizeServer),
                project: mcp.project ? mcp.project.servers.map(summarizeServer) : [],
                offGlobal: mcp.project ? mcp.project.offGlobal : [],
                external: mcp.external.map((e) => ({ name: e.name, agent: e.agent, source: e.source, type: e.type })),
              },
              threadProposals: proposals.map((p) => ({
                id: p.id,
                kind: p.draft.kind,
                name: p.draft.name,
                scope: p.scope,
                status: p.status,
                ...(p.error ? { error: p.error } : {}),
              })),
            },
            null,
            2,
          ),
        };
      },
    }),
    define({
      name: CREATOR_PROPOSE_TOOL,
      description: "Validate and stage a skill or MCP connector proposal for user review. Never write skill files or mcp.json directly.",
      input: {
        scope: z.enum(["project", "global"]),
        kind: z.enum(["skill", "connector"]),
        name: z.string(),
        description: z.string().optional(),
        files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
        spec: z
          .object({
            type: z.enum(["stdio", "http", "sse"]),
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
            env: stringMapSchema.optional(),
            url: z.string().optional(),
            headers: stringMapSchema.optional(),
            oauth: z
              .object({
                clientId: z.string().optional(),
                scopes: z.string().optional(),
                callbackPort: z.number().int().optional(),
              })
              .optional(),
          })
          .optional(),
      },
      autoAllow: true,
      effect: "mutate",
      summarize: (a) => [a.kind, a.name, a.scope].filter(Boolean).join(" "),
      run: async (args) => {
        const thread = deps.threadOf(threadId);
        if (!thread) return error("Thread not found.");
        if (thread.permissionMode === "plan") {
          return error("Cannot propose an extension while in Plan mode. Switch to Ask or Auto-edit first.");
        }
        const project = deps.projectOf(thread.projectId);
        const chatsThread = project ? isChatsRoot(project.path, deps.chatsRoot) : true;
        if (args.scope === "project" && (!project || chatsThread)) {
          return error('Chats threads have no project folder; propose with scope "global" instead.');
        }
        const scope: ProposalScope = args.scope === "project" && project ? { kind: "project", projectId: project.id } : { kind: "global" };

        const stagedCount = deps.extensions.forThread(threadId).filter((p) => p.status === "staged").length;
        if (stagedCount >= limit) {
          return error(`At most ${limit} staged proposals are allowed per thread. Ask the user to install or reject an existing proposal first.`);
        }

        const draftInput =
          args.kind === "skill"
            ? { kind: "skill" as const, name: args.name, description: args.description, files: args.files }
            : { kind: "connector" as const, name: args.name, spec: args.spec };

        const check = validateProposal(draftInput, {
          scope,
          reservedNames: args.kind === "skill" ? bundledNames() : [],
        });
        if (!check.ok) return error(check.errors.join("\n"));

        const stored = deps.extensions.stage({
          threadId,
          scope: check.proposal.scope,
          draft: check.proposal.draft,
          digest: check.proposal.digest,
        });
        deps.emitProposal(threadId, stored.id);

        return {
          text: JSON.stringify({
            proposalId: stored.id,
            status: stored.status,
            kind: stored.draft.kind,
            name: stored.draft.name,
            scope: stored.scope,
            message: "Proposal staged for user review. Wait for the user to install or reject it; do not claim it is installed yet.",
          }),
        };
      },
    }),
  ];
}
