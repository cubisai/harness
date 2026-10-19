import type { RunUsage } from "../../../shared/types";
// The harness's own tools: what each one declares and what it gets when it runs.
// The loop advertises `parameters` to the model, gates a call by `access`, and
// shows `display` in the thread (names the renderer already knows: Read, Edit, Run…).

/** What a call can touch; permission modes allow or ask per access. */
/** "web" reaches the network (web_fetch): a URL can carry data out, so it asks like a shell call. */
export type ToolAccess = "read" | "edit" | "shell" | "web" | "other";

export interface ToolContext {
  /** The thread's working folder; relative paths resolve against it. */
  cwd: string;
  signal: AbortSignal;
  /** Where bounded tool output is saved in full, one file per call. */
  outputDir: string;
  /** The call's id, for saved-output file names. */
  callId: string;
  /** Files read this session: absolute path → mtimeMs at the read. Edit/Write check it. */
  reads: Map<string, number>;
  /** The git guardrail script (guard.checkCommand); BUILT_IN_GUARD for the built-in rules. */
  guardScript: string;
  /** Live output (Bash), shown while the call runs. */
  onOutput?(text: string): void;
  /** Test seam and platform override. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** What the thread shows for a call: the renderer's payload shapes. */
export interface ToolDisplay {
  /** One line: a path, a command, a pattern. */
  summary: string;
  /** tool-use payload: `{ command }` for Run, the arguments otherwise. */
  input?: unknown;
  /** tool-result payload: `{ diff: [{ path, unified }] }` for edits, `{ exitCode, output }` for Run. */
  result?: unknown;
}

export interface ToolResult {
  /** What the model reads. */
  text: string;
  isError?: boolean;
  /** A PNG the model should see, base64. */
  imagePng?: string;
  display?: ToolDisplay;
  /** A subagent call's own usage, carried onto its tool-result event. */
  runUsage?: RunUsage;
}

export interface NativeTool {
  /** The name the model calls. */
  name: string;
  /** The name the thread shows (Claude's names: the renderer maps them to Read / Edit / Run / Search). */
  displayName: string;
  description: string;
  /** JSON Schema of the arguments: `{ type: "object", properties, required }`. */
  parameters: Record<string, unknown>;
  access: ToolAccess;
  /** One line for the thread and the permission card, from the raw arguments. */
  summarize(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** A tool failure the model should read and recover from (not a crash). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Read a string argument; throws ToolError when required and missing. */
export function str(args: Record<string, unknown>, key: string, required: true): string;
export function str(args: Record<string, unknown>, key: string, required?: false): string | undefined;
export function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = args[key];
  if (typeof v === "string") return v;
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`Missing required argument "${key}".`);
    return undefined;
  }
  throw new ToolError(`Argument "${key}" must be a string.`);
}

/** Read a number argument (a numeric string is accepted: small models send them). */
export function int(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`Argument "${key}" must be a number.`);
  return Math.trunc(n);
}

export function bool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  return v === true || v === "true";
}
