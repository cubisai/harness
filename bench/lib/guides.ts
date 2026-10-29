// The repo's CLAUDE.md as a bench project gets it.

/** CLAUDE.md without its opencode-delegation section: an agent in the app must never try to dispatch opencode workers. */
export function withoutDelegation(text: string): string {
  const start = text.search(/^## opencode delegation/m);
  if (start < 0) return text;
  const next = text.slice(start + 1).search(/^## /m);
  return (text.slice(0, start) + (next < 0 ? "" : text.slice(start + 1 + next))).trimEnd() + "\n";
}
