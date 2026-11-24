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

/** Words for tool ids whose plain spelling reads badly; anything else gets its id as words. */
const TOOL_WORDS: Record<string, string> = {
  run_code: "Script",
  apply_patch: "Edit",
  web_fetch: "Fetch",
  ask_user: "Question",
  search_tools: "Find tools",
  call_mcp_tool: "Tool",
  browser_open: "Open page",
  browser_screenshot: "Screenshot",
  browser_snapshot: "Page snapshot",
  browser_eval: "Page script",
  browser_click: "Click",
  browser_type: "Type",
  browser_logs: "Page logs",
  browser_report: "Page check",
  browser_tools: "Browser tools",
  browser_call: "Browser",
  shell_start: "Start command",
  shell_output: "Command output",
  shell_stop: "Stop command",
  shell_list: "Commands",
  dev_server: "Dev server",
  dev_server_start: "Start dev server",
  design_screenshot: "Screenshot",
  design_lint: "Design check",
  design_tokens_apply: "Apply tokens",
  design_part_preview: "Part preview",
  design_set_direction: "Set direction",
  design_reference_search: "Find references",
  design_reference_get: "Reference",
  design_kit_inspect: "Inspect kit",
  design_kit_save: "Save kit",
  design_critique_save: "Save critique",
  memory_read: "Read memory",
  memory_write: "Save memory",
  issue_create: "File issue",
  document_build: "Build document",
  document_check: "Check document",
  document_template: "Document template",
  TodoWrite: "Plan",
  todowrite: "Plan",
  update_plan: "Plan",
  skill: "Load skill",
  Skill: "Load skill",
  creator_inspect: "Inspect",
  creator_propose: "Propose",
  creator_app_preview: "Preview app",
  creator_app_check: "Check app",
  creator_connector_test: "Test connector",
  creator_theme_preview: "Preview theme",
};

/** `design_tokens_apply` / `kebab-name` / `camelName` → "Design tokens apply". */
function words(id: string): string {
  const spaced = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : id;
}

/**
 * The name a tool row shows (display only; logic compares `canonicalTool`):
 * Claude-style names stay as they are, CubiQ's own snake_case ids read as
 * words ("run_code" → "Script", "browser_screenshot" → "Screenshot"), another
 * MCP server's tool keeps its server ("github · Create issue"). A browser_call
 * or call_mcp_tool row names the tool it called, from its payload.
 */
export function toolLabel(name: string, payload?: unknown): string {
  const canon = canonicalTool(name);
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (canon === "browser_call" && typeof p?.tool === "string") return toolLabel(p.tool);
  if (canon === "call_mcp_tool" && typeof p?.tool === "string") return typeof p.server === "string" ? `${p.server} · ${toolLabel(p.tool)}` : toolLabel(p.tool);
  const known = TOOL_WORDS[canon];
  if (known) return known;
  if (canon.includes(" · ")) {
    const [server, ...rest] = canon.split(" · ");
    return `${server} · ${rest.map((r) => TOOL_WORDS[r] ?? words(r)).join(" · ")}`;
  }
  // Already a display name (Run, Edit, Agent, Skill…): keep it.
  if (/^[A-Z][A-Za-z]*$/.test(canon)) return canon;
  return /[_-]|^[a-z]/.test(canon) ? words(canon) : canon;
}

export const SUMMARY_MAX = 160;

/** The one clip rule for one-line summaries: at most `max` chars, ending in "…" when cut. */
export function clipSummary(text: string, max = SUMMARY_MAX): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * A subagent call's summary, "<description> · <agent type>": only the
 * description is clipped, so the agent type (a team member's id, which the
 * team strip matches on) always survives.
 */
export function clipAgentSummary(description: string, agentType: string): string {
  const type = agentType.replace(/\s+/g, " ").trim();
  return `${clipSummary(description, Math.max(16, SUMMARY_MAX - type.length - 3))} · ${type}`;
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
