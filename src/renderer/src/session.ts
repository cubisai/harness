import type { PermissionMode } from "../../shared/types";

/** Where the user left off: reopened on the next launch. */
export interface SavedSession {
  projectId: string | null;
  /** The open thread; null = the project's start page. */
  threadId: string | null;
  /** The agent the last thread used or switched to (new threads start on it). */
  lastAgent: string | null;
  /** The new-thread pickers. */
  draft: {
    agent?: string;
    model?: string;
    effort?: string | null;
    contextWindow?: number | null;
    permissionMode?: PermissionMode;
  };
}

const SESSION_KEY = "cubiq.session";
const MODES: PermissionMode[] = ["ask", "auto-edit", "plan", "full"];

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The saved session off localStorage; a missing or malformed entry reads as null, and bad fields are dropped. */
export function readSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    const d = p.draft && typeof p.draft === "object" ? (p.draft as Record<string, unknown>) : {};
    const draft: SavedSession["draft"] = {};
    if (str(d.agent)) draft.agent = d.agent as string;
    if (str(d.model)) draft.model = d.model as string;
    if (d.effort === null || str(d.effort)) draft.effort = d.effort as string | null;
    if (d.contextWindow === null || (typeof d.contextWindow === "number" && d.contextWindow > 0)) draft.contextWindow = d.contextWindow as number | null;
    if (MODES.includes(d.permissionMode as PermissionMode)) draft.permissionMode = d.permissionMode as PermissionMode;
    return {
      projectId: str(p.projectId),
      threadId: str(p.threadId),
      lastAgent: str(p.lastAgent),
      draft,
    };
  } catch {
    return null;
  }
}

let lastWritten = "";

/** Save where the user is (unchanged sessions aren't rewritten); storage failure just skips the write. */
export function writeSession(session: SavedSession): void {
  const json = JSON.stringify(session);
  if (json === lastWritten) return;
  try {
    localStorage.setItem(SESSION_KEY, json);
    lastWritten = json;
  } catch {
    // Private or full storage: the next launch opens the first project, as before.
  }
}

/**
 * What to open on launch: the saved project and thread when they still exist, else the first project's newest
 * thread. A saved start page (no thread) stays a start page.
 */
export function restoreTarget(
  saved: SavedSession | null,
  projects: { id: string }[],
  threads: Record<string, { id: string }[]>,
): { projectId: string; threadId: string | null } | null {
  const project = projects.find((p) => p.id === saved?.projectId);
  if (project) {
    const list = threads[project.id] ?? [];
    if (saved!.threadId === null) return { projectId: project.id, threadId: null };
    return {
      projectId: project.id,
      threadId: list.find((t) => t.id === saved!.threadId)?.id ?? list[0]?.id ?? null,
    };
  }
  const first = projects[0];
  if (!first) return null;
  return { projectId: first.id, threadId: threads[first.id]?.[0]?.id ?? null };
}

/** The saved new-thread pickers, kept only when their agent is still installed (another agent's model would be wrong). */
export function restoreDraft(saved: SavedSession | null, agents: { id: string }[]): Pick<SavedSession, "draft" | "lastAgent"> {
  const known = (id: string | null | undefined) => Boolean(id && agents.some((a) => a.id === id));
  if (!saved) return { draft: {}, lastAgent: null };
  const lastAgent = known(saved.lastAgent) ? saved.lastAgent : null;
  // A draft without its own agent picked models for the last agent: it only holds while that agent does.
  const agentOk = saved.draft.agent !== undefined ? known(saved.draft.agent) : saved.lastAgent === lastAgent;
  const { permissionMode } = saved.draft;
  return {
    draft: agentOk ? saved.draft : permissionMode ? { permissionMode } : {},
    lastAgent,
  };
}
