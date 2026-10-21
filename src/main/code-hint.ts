/** Code mode "only" on an agent whose shell can't be hidden (every agent's Bash): one fixed line, the same every session (cache-safe). */
export const CODE_ONLY_HINT = "To read or search files, write one run_code script that chains read, grep and glob, instead of separate shell commands.";

/** Why a shell search is turned away in code mode "only" (Claude's hook, the native agent's Bash). */
export const CODE_ONLY_DENY = "Code mode is set to Only: search with one run_code script (tools.grep, tools.glob, tools.read) instead of a shell search.";

/** Whether a shell command is a file search (grep, rg, find…), optionally after a leading `cd dir &&`. */
export function isShellSearch(command: string): boolean {
  return /^\s*(?:cd\s+\S+\s*&&\s*)?(?:grep|egrep|fgrep|rg|ag|ack|find|fd)\b/.test(command);
}
