/** A local automation's schedule: a fixed interval, or a wall-clock time on chosen days. */
export type Schedule =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; at: string; days?: number[]; timeZone: string };

/** What to do with runs missed while the app was closed: fold them into one, or drop them. */
export type MissedPolicy = "coalesce" | "skip";

/** The lifecycle of one run of an automation. */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting-input"
  | "paused-budget"
  | "partial"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

/** How a run's tools are approved: unattended (full access, git guardrails on) or asking the user. */
export type AutomationPermissions = "unattended" | "ask";

/** A run's outcome as the renderer sees it (Message Center rows, the automation list). */
export interface AutomationNotice {
  automationId: string;
  name: string;
  runId: number;
  threadId: string | null;
  status: RunStatus;
  costUsd: number | null;
  endedAt: number | null;
  error: string | null;
}

/** A starting point for a new automation: its prompt, schedule and budget. */
export interface AutomationTemplate {
  id: "repo-health" | "browser-smoke" | "project-brief" | "eval-regression" | "custom";
  name: string;
  description: string;
  prompt: string;
  schedule: Schedule;
  budgetUsd: number | null;
}

/** What the editor saves; the main process validates the schedule. */
export interface AutomationInput {
  name: string;
  template: string;
  prompt: string;
  schedule: Schedule;
  missed: MissedPolicy;
  enabled: boolean;
  agent: string | null;
  model: string | null;
  budgetUsd: number | null;
  permissions: AutomationPermissions;
}

/** One automation as the Library lists it. */
export interface AutomationView extends AutomationInput {
  id: string;
  projectId: string;
  /** describeSchedule(), e.g. "daily at 09:00 (Europe/London)". */
  scheduleText: string;
  /** The next scheduled instant; null when disabled. */
  nextAt: number | null;
  lastRun: AutomationNotice | null;
}

export interface AutomationsOverview {
  templates: AutomationTemplate[];
  automations: AutomationView[];
}
