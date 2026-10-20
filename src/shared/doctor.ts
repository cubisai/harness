// The /doctor report's data contract: the main process fills it in, the
// renderer draws it. Pure types, safe to import from either side.

/** How loudly a finding asks for attention. */
export type DoctorLevel = "ok" | "warn" | "error";

/**
 * Something the user can do about a finding. `run` is only for an allowlisted
 * install or upgrade command and runs after a click; `copy` is never run.
 */
export type DoctorFix =
  | { kind: "run"; label: string; command: string; args: string[] }
  | { kind: "pin"; label: string; agent: string; path: string }
  | { kind: "prune-worktrees"; label: string; dirs: string[] }
  | { kind: "copy"; label: string; text: string };

/** One result from the doctor: what it found and how to fix it. */
export interface DoctorFinding {
  id: string;
  group: "agents" | "environment" | "worktrees";
  agent?: string;
  level: DoctorLevel;
  title: string;
  detail: string;
  fixes: DoctorFix[];
}

/** The findings from one run, with the time they were produced. */
export interface DoctorReport {
  at: number;
  findings: DoctorFinding[];
}

/** What a fix did, in one line for the Doctor sheet. */
export interface DoctorFixResult {
  ok: boolean;
  message: string;
}
