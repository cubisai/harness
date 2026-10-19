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
