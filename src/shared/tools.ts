/**
 * The one display name per tool concept and the one clip rule for summaries,
 * shared by every agent adapter so stored events read the same whichever
 * agent ran the tool.
 */

/** The one display name per tool concept, whichever agent ran it. */
export function canonicalTool(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.slice("mcp__".length).split("__");
    if (parts[0] === "cubiq" || parts[0] === "unskilled") return parts.slice(1).join("__");
    return parts.join(" · ");
  }
  switch (name) {
    case "Bash":
      return "Run";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "Edit";
    case "Read":
      return "Read";
    case "Grep":
    case "Glob":
    case "WebSearch":
      return "Search";
    case "WebFetch":
      return "Fetch";
    default:
      return name;
  }
}

/** Alias for events stored before the mapping existed; the renderer reads both the same. */
export const prettyTool = canonicalTool;

export const SUMMARY_MAX = 160;

/** The one clip rule for one-line summaries: at most `max` chars, ending in "…" when cut. */
export function clipSummary(text: string, max = SUMMARY_MAX): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** One file's edit, as a git-style unified diff text. */
export interface ToolDiff {
  path: string;
  unified: string;
}

/** Payload of a Run tool call. */
export interface RunPayload {
  command: string;
}

/** Payload of a Run tool result. */
export interface RunResult {
  exitCode: number | null;
  output: string;
}

/** Payload of an Edit tool result. */
export interface EditResult {
  diff: ToolDiff[];
}
