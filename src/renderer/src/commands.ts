/** The message box's "/" commands: plan mode, the model picker, the issue picker, context, MCP servers, a new thread, doctor and code mode. The other permission modes live on the mode chip (and ⇧Tab). */

/** One command the message box can run when the text starts with "/name". */
export interface ComposerCommand {
  name: string;
  description: string;
}

/** Every "/" command, in menu order. */
export const COMPOSER_COMMANDS: ComposerCommand[] = [
  { name: "plan", description: "Plan mode: investigate read-only, then propose a plan" },
  { name: "model", description: "Pick a model" },
  { name: "issue", description: "Pick the issue this thread works on; /issue <description> files a new one" },
  { name: "issue-setup", description: "Set up where issues live: GitHub, GitLab, Gitea or local files" },
  { name: "triage", description: "Triage open issues; /triage 12 or /triage move 12 to ready-for-agent" },
  { name: "pr", description: "Open a PR linked to this thread's issue; /pr 12 links #12, /pr update" },
  { name: "context", description: "Show what this thread loads into context" },
  { name: "mcp", description: "MCP servers: status, sign-in, tools; /mcp <url or command> adds one" },
  { name: "compact", description: "Compact the conversation now; add a focus: /compact keep the API decisions" },
  { name: "new", description: "Start a new thread" },
  { name: "doctor", description: "Check agent installs, versions and conflicts, and fix them" },
  { name: "codemode", description: "Turn code mode (run_code) on or off for new threads; /codemode on or /codemode off" },
];

/** The bundled skills the issue commands run: they're "/" commands, so the "$" menus leave them out. */
const COMMAND_SKILLS = new Set(["issue", "issue-setup", "triage", "pr"]);

/** A bundled skill the composer runs as a "/" command rather than offering under "$". */
export function isCommandSkill(skill: { name: string; origin?: string }): boolean {
  return skill.origin === "bundled" && COMMAND_SKILLS.has(skill.name);
}

/** "/issue <description>", "/issue-setup", "/triage 12", "/pr 12": the skill to run and its argument; null for other text and a bare "/issue" (the picker). */
export function issueCommand(text: string): { skill: string; args: string } | null {
  const m = /^\/(issue-setup|issue|triage|pr)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const args = m[2]?.trim() ?? "";
  return m[1] === "issue" && !args ? null : { skill: m[1]!, args };
}

/** Commands matching the query: name-prefix matches first, then any name substring. */
export function matchCommands(query: string): ComposerCommand[] {
  const q = query.toLowerCase();
  const prefix: ComposerCommand[] = [];
  const rest: ComposerCommand[] = [];
  for (const c of COMPOSER_COMMANDS) {
    if (c.name.startsWith(q)) prefix.push(c);
    else if (c.name.includes(q)) rest.push(c);
  }
  return [...prefix, ...rest];
}
