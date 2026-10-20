/** The message box's "/" commands: plan mode, the model picker, context, MCP servers, and a new thread. The other permission modes live on the mode chip (and ⇧Tab). */

/** One command the message box can run when the text starts with "/name". */
export interface ComposerCommand {
  name: string;
  description: string;
}

/** Every "/" command, in menu order. */
export const COMPOSER_COMMANDS: ComposerCommand[] = [
  { name: "plan", description: "Plan mode: investigate read-only, then propose a plan" },
  { name: "model", description: "Pick a model" },
  { name: "context", description: "Show what this thread loads into context" },
  { name: "mcp", description: "MCP servers: status, sign-in, tools; /mcp <url or command> adds one" },
  { name: "compact", description: "Compact the conversation now; add a focus: /compact keep the API decisions" },
  { name: "new", description: "Start a new thread" },
  { name: "doctor", description: "Check agent installs, versions and conflicts, and fix them" },
];

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
