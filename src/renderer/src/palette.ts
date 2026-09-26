/** One row in the command palette. */
export interface Command {
  id: string;
  section: "Actions" | "Skills" | "Threads" | "Projects";
  title: string;
  /** Secondary text: a skill's description, a thread's project. */
  detail?: string;
  /** A keyboard shortcut to show on the right. */
  shortcut?: string;
  /** Extra words that should find this command. */
  keywords?: string;
  run(): void;
}

const SECTION_ORDER: Command["section"][] = ["Actions", "Skills", "Threads", "Projects"];

/**
 * Commands matching the query, best first. Every word of the query has to
 * appear in the title, detail, or keywords; a title that starts with the
 * query, or has a word that does, ranks above one that only contains it.
 * With no query: actions, then the most recent threads. A query starting with
 * ">" ranks only Actions against whatever follows the ">".
 */
export function rankCommands(commands: Command[], query: string, limit = 60): Command[] {
  if (query.trimStart().startsWith(">")) {
    const actions = commands.filter((c) => c.section === "Actions");
    return rankCommands(actions, query.trimStart().slice(1), limit);
  }
  const q = query.trim().toLowerCase().replace(/^\//, "");
  if (!q) {
    const actions = commands.filter((c) => c.section === "Actions");
    const threads = commands.filter((c) => c.section === "Threads").slice(0, 5);
    return [...actions, ...threads];
  }
  const words = q.split(/\s+/);
  const scored: { c: Command; score: number; i: number }[] = [];
  commands.forEach((c, i) => {
    const title = c.title.toLowerCase().replace(/^\//, "");
    const hay = `${title} ${c.detail ?? ""} ${c.keywords ?? ""}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return;
    let score = 0;
    if (title.startsWith(q)) score += 4;
    else if (title.split(/[\s/:·-]+/).some((w) => w.startsWith(words[0]!))) score += 2;
    else if (title.includes(words[0]!)) score += 1;
    score -= SECTION_ORDER.indexOf(c.section) * 0.1; // ties: actions, then skills, threads, projects
    scored.push({ c, score, i });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((s) => s.c);
}
