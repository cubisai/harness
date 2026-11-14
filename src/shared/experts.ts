/**
 * The Library's Experts. A design expert is a real preset: starting it opens a
 * design thread with its skills already added as chips and its design system
 * picked. The others still open a plain chat thread.
 */
export interface ExpertPreset {
  id: string;
  name: string;
  persona: string;
  category: string;
  avatarText: string;
  description: string;
  tags: string[];
  /** "design" starts a design thread. */
  kind?: "design";
  /** Skills added to the first message as chips. */
  skills?: string[];
  /** A design system id; absent = Auto (the agent picks a style, or the project's own DESIGN.md). */
  designSystem?: string;
}

export const EXPERTS: ExpertPreset[] = [
  {
    id: "ui-designer",
    name: "UI Designer",
    persona: "Sam",
    category: "Design",
    avatarText: "UI",
    description: "Designs web pages and app screens as live prototypes on the canvas, with every state, on the 8pt grid.",
    tags: ["Prototype", "Web", "States"],
    kind: "design",
    skills: ["design-build"],
  },
  {
    id: "mobile-designer",
    name: "Mobile Designer",
    persona: "Noor",
    category: "Design",
    avatarText: "MO",
    description: "Lays out iOS and Android screens and flows in real-size phone frames, with safe areas and 44pt targets.",
    tags: ["iOS", "Android", "Flows"],
    kind: "design",
    skills: ["design-build"],
  },
  {
    id: "slide-designer",
    name: "Slide Designer",
    persona: "Ines",
    category: "Design",
    avatarText: "SD",
    description: "Turns a story into a 1920×1080 deck you can click through, present and print to PDF.",
    tags: ["Slides", "Storytelling", "PDF"],
    kind: "design",
    skills: ["design-build"],
  },
  {
    id: "design-system-architect",
    name: "Design-System Architect",
    persona: "Theo",
    category: "Design",
    avatarText: "DS",
    description: "Extracts a kit from a site, a screenshot or your code: its tokens and rules on the kit's parts, ready to design with.",
    tags: ["Tokens", "DESIGN.md", "Extraction"],
    kind: "design",
    skills: ["design-kit"],
  },
  {
    id: "ux-critic",
    name: "UX Critic",
    persona: "Rae",
    category: "Design",
    avatarText: "UX",
    description: "Reviews a design against hierarchy, spacing, contrast, tokens and states, then fixes what it finds.",
    tags: ["Critique", "Accessibility", "Polish"],
    kind: "design",
    skills: ["design-review"],
  },
  {
    id: "code-review",
    name: "Code Review Expert",
    persona: "Kim",
    category: "Engineering",
    avatarText: "CR",
    description: "Examines every line of code with eagle-eye standards, intercepting defects and module boundary violations.",
    tags: ["Code Review", "Quality Gate", "Security"],
  },
  {
    id: "frontend-dev",
    name: "Frontend Developer",
    persona: "Paul",
    category: "Engineering",
    avatarText: "FE",
    description: "Expert in modern web technologies, responsive SPAs, React hooks, and state management.",
    tags: ["Frontend Dev", "React", "TypeScript"],
  },
  {
    id: "diagram-expert",
    name: "Diagram Design Expert",
    persona: "Mia",
    category: "Data & AI",
    avatarText: "DG",
    description: "Transforms complex software architectures and workflows into clear Mermaid and SVG diagrams.",
    tags: ["Mermaid Diagrams", "Architecture", "SVG"],
  },
  {
    id: "senior-pm",
    name: "Senior Project Manager",
    persona: "Dylan",
    category: "Project & Quality",
    avatarText: "PM",
    description: "Breaks down vague requirements into actionable milestones, specs, and risk-managed delivery plans.",
    tags: ["Project Management", "Scoping", "Milestones"],
  },
  {
    id: "data-reporter",
    name: "Data Analytics Reporter",
    persona: "Phoebe",
    category: "Data & AI",
    avatarText: "DA",
    description: "Transforms complex data into clear actionable business insights, visual charts, and executive summaries.",
    tags: ["Data Analysis", "Reporting", "Dashboards"],
  },
];

/**
 * An expert is a persona: a markdown system prompt plus the metadata that
 * describes it. A thread may carry one expert id (see Thread.expertId), which
 * the service turns into the `<expert>` block appended to the agent's
 * instructions. `kind: "team"` marks a lead that can hand steps to `members`.
 */
export interface ExpertMember {
  id: string;
  name: string;
  profession: string;
  description: string;
  prompt: string;
  skills: string[];
  /** The member's turn budget as a subagent (a package's `maxTurns`); absent = the engine's default. */
  maxTurns?: number;
  /** The member's own model, used where the engine supports per-subagent models; absent = the lead's. */
  model?: string;
  /** The member's own effort, used where the engine supports per-subagent reasoning; absent = the lead's. */
  effort?: "low" | "medium" | "high";
}

export interface ExpertDef {
  id: string;
  kind: "agent" | "team";
  name: string;
  profession: string;
  persona: string;
  category: string;
  avatarText: string;
  description: string;
  tags: string[];
  quickPrompts: string[];
  prompt: string;
  skills: string[];
  threadKind?: "design";
  designSystem?: string;
  /** Team members, in order; only set for `kind: "team"` (the lead is the def itself). */
  members?: ExpertMember[];
  source: "builtin" | "imported";
  version: string;
  /** Where an imported expert came from (a GitHub link, a folder or a .zip path); re-importing it updates the expert. */
  sourceUrl?: string;
  author?: string;
  /** An imported package's license: SPDX-ish ("MIT", "custom"), or "none" when the package has no license file. */
  license?: string;
  /** The expert.md this def was read from, when it came from disk. */
  path?: string;
}

/** An expert id: lower-case letters, digits and dashes, 1-64 chars, first char alphanumeric. */
export const EXPERT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The prompt cap: a runaway file never bloats every turn's instructions. */
const EXPERT_PROMPT_MAX = 24000;

/**
 * Split an expert's markdown into its leading `---` frontmatter block and the
 * body. The frontmatter is YAML-ish only: simple `key: value` lines, where a
 * value may be a JSON-style inline list `[a, b, "c d"]` (quotes stripped), or a
 * key followed by indented `- item` lines. No YAML dependency; CRLF is handled.
 * No frontmatter → `{}` and the whole text as the body.
 */
export function parseExpertMarkdown(text: string, fallbackId: string): { meta: Record<string, string | string[]>; body: string } {
  const normalized = text.replace(/\r\n?/g, "\n");
  // A frontmatter block only counts at the very top: a `---` that opens the file.
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { meta: {}, body: normalized.trim() };
  const meta: Record<string, string | string[]> = {};
  const lines = match[1]!.split("\n");
  let pendingKey: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = /^[ \t]/.test(line);
    const item = /^[ \t]*-[ \t]*(.*)$/.exec(line);
    // An indented `- item` continues the last key as a list.
    if (indent && item && pendingKey) {
      const prior = meta[pendingKey];
      const list = Array.isArray(prior) ? prior : typeof prior === "string" && prior ? [prior] : [];
      list.push(stripQuotes(item[1]!.trim()));
      meta[pendingKey] = list;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    meta[key] = parseValue(kv[2]!.trim());
    pendingKey = key;
  }
  return { meta, body: normalized.slice(match[0].length).trim() };
}

/** A frontmatter value: an inline `[a, b, "c d"]` list, else the bare string. */
function parseValue(value: string): string | string[] {
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitList(value.slice(1, -1))
      .map((v) => stripQuotes(v.trim()))
      .filter((v) => v.length > 0);
  }
  return stripQuotes(value);
}

/** Split an inline list on commas outside quotes, so `"a, b", c` is two items. */
function splitList(inner: string): string[] {
  const items: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ",") {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  items.push(inner.slice(start));
  return items;
}

function stripQuotes(value: string): string {
  const m = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  return m ? m[1]! : value;
}

/** A meta value as one trimmed string, or "" when it's a list/absent. */
function str(meta: Record<string, string | string[]>, key: string): string {
  const value = meta[key];
  return typeof value === "string" ? value.trim() : "";
}

/** A meta value as a trimmed string list (inline, dash list, or a lone string). */
function strList(meta: Record<string, string | string[]>, key: string): string[] {
  const value = meta[key];
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter((v) => v.length > 0);
  return value && value.trim() ? [value.trim()] : [];
}

/**
 * Build an expert from an expert.md: the meta keys above an optional team
 * layout, the body as its prompt. Returns null on a bad id, a missing name or
 * an empty body. Members are a separate concern (the catalogue reads them).
 */
export function expertFromMarkdown(text: string, fallbackId: string, source: "builtin" | "imported"): ExpertDef | null {
  const { meta, body } = parseExpertMarkdown(text, fallbackId);
  const id = str(meta, "id") || fallbackId;
  if (!EXPERT_ID_RE.test(id)) return null;
  const name = str(meta, "name");
  if (!name) return null;
  const prompt = body.trim();
  if (!prompt) return null;
  const kind: ExpertDef["kind"] = str(meta, "kind") === "team" ? "team" : "agent";
  const avatarText = str(meta, "avatar") || name.slice(0, 2).toUpperCase();
  const threadKind = str(meta, "threadKind") === "design" ? ("design" as const) : undefined;
  return {
    id,
    kind,
    name,
    profession: str(meta, "profession"),
    persona: str(meta, "persona"),
    category: str(meta, "category") || "General",
    avatarText,
    description: str(meta, "description"),
    tags: strList(meta, "tags"),
    quickPrompts: strList(meta, "quickPrompts"),
    skills: strList(meta, "skills"),
    ...(threadKind ? { threadKind } : {}),
    ...(str(meta, "designSystem") ? { designSystem: str(meta, "designSystem") } : {}),
    prompt: prompt.slice(0, EXPERT_PROMPT_MAX),
    source,
    version: str(meta, "version") || "1.0.0",
    ...(str(meta, "sourceUrl") ? { sourceUrl: str(meta, "sourceUrl") } : {}),
    ...(str(meta, "author") ? { author: str(meta, "author") } : {}),
    ...(str(meta, "license") ? { license: str(meta, "license") } : {}),
  };
}

/** A skill an expert package ships in its own `skills/` folder; private to the agent it's bound to. */
export interface ExpertSkill {
  name: string;
  /** One line, from SKILL.md's frontmatter. */
  description: string;
  /** Absolute path of its SKILL.md. */
  file: string;
}

/**
 * The private index of an agent's package skills, appended to the prompt of
 * the lead or member it's bound to. Empty string when it has none.
 */
export function skillsIndexBlock(skills: ExpertSkill[]): string {
  if (!skills.length) return "";
  const lines = [
    "<skills>",
    "These skills are yours alone. Before using one, read its SKILL.md; relative paths in it resolve against that file's folder. Run a skill's scripts with your shell tool instead of pasting them, and write output files to the project or the team workspace, never into a skill folder.",
    ...skills.map((s) => (s.description ? `- \`${s.name}\` — ${s.description} — ${s.file}` : `- \`${s.name}\` — ${s.file}`)),
    "</skills>",
  ];
  return lines.join("\n");
}

/**
 * The text injected into an agent's instructions for a thread's expert: the
 * persona prompt wrapped in an `<expert>` block, the lead's package skills
 * as a private index, and, for a team, its members and the team protocol.
 * It ends with the Stay line that anchors the persona to the whole thread.
 * Double quotes in attributes are escaped so the markup stays well-formed.
 */
export function expertBlock(def: Pick<ExpertDef, "name" | "profession" | "prompt" | "kind" | "members">, leadSkills: ExpertSkill[] = []): string {
  const attr = (value: string) => value.replace(/"/g, "&quot;");
  const head = `<expert name="${attr(def.name)}" role="${attr(def.profession)}">`;
  const body = `${head}\n${def.prompt}\n</expert>`;
  const index = skillsIndexBlock(leadSkills);
  const stay = def.profession ? `Stay ${def.name}, ${def.profession}, for this whole thread.` : `Stay ${def.name} for this whole thread.`;
  if (def.kind !== "team" || !def.members?.length) return [...(index ? [body, index] : [body]), stay].join("\n\n");
  const lines = def.members.map((m) => `- \`${m.id}\` — ${m.name}, ${m.profession}: ${m.description}`);
  return [
    body,
    ...(index ? [index] : []),
    "## Your team",
    lines.join("\n"),
    TEAM_LEAD_PROTOCOL,
    stay,
  ].join("\n\n");
}

/** A team member as an engine subagent: Claude SDK `agents`, OpenCode `agent.<id>`. */
export interface TeamAgent {
  id: string;
  description: string;
  prompt: string;
  /** Turn budget as a subagent; absent = the engine's default. */
  maxTurns?: number;
  /** The member's own model, used where the engine supports per-subagent models; absent = the lead's. */
  model?: string;
  /** The member's own effort, used where the engine supports per-subagent reasoning; absent = the lead's. */
  effort?: "low" | "medium" | "high";
}

/**
 * How the lead runs its team, after the roster: briefs, the shared
 * workspace tools (team_write / team_read / team_post / team_board) and
 * the final synthesis. Kept short: it rides every turn of a team thread.
 */
export const TEAM_LEAD_PROTOCOL = [
  "## How the team works",
  "- Size the request first. Answer a quick question, a clarification or a follow-up on results you already have yourself, without calling anyone. Delegate work that needs a member's specialty, and only to the members it needs: a narrow ask goes to one member, never the whole team.",
  "- Hand a member one step with your subagent tool (subagent type = the member id). Don't end your turn while a member you briefed is still working.",
  "- Steps that don't depend on each other run in parallel (one subagent call each, in the same message). Use phases only when a step needs another member's result, and start it once that result is in. Tell the user one short line when you hand work out.",
  "- Each brief states: the objective; the inputs (workspace result files from earlier members, project paths); the member skill to use if any; the expected outcome, format and length; the evidence to include (sources, files, commands and their results); the boundaries (what not to touch, what other members cover); and when to stop.",
  "- Specialist work in a member's field goes to that member: don't write it yourself or speak for a member. You size, brief, relay and synthesize.",
  "- Members save full results with `team_write` and reply with a short summary and the file name. Give a dependent member those file names instead of retelling the results; call `team_read` only when a summary isn't enough.",
  "- Members report only to you. `team_board` (for: \"lead\") lists their notes and the workspace files; `team_post` sends a member a note.",
  "- Route factual claims through the team's verifying member when it has one. The final answer is yours: consolidate, resolve conflicts, name the files it rests on.",
].join("\n");

/** How a member works inside the team: one step, results to the workspace, a short reply. */
export function teamMemberProtocol(id: string): string {
  return [
    "## Working in the team",
    `Your team id is \`${id}\`; the lead is \`lead\`. Do only the step in your brief.`,
    `- Save your full result with \`team_write\` (from: "${id}", name: "${id}-<step>"), then reply to the lead with at most 200 words: the outcome, the evidence it rests on, the file name and open questions.`,
    `- Read other members' results with \`team_read\` when your brief names them. \`team_board\` (for: "${id}") shows notes for you; \`team_post\` reaches the lead only (to: "lead"), never other members.`,
    "- Don't edit project files unless your brief says to.",
  ].join("\n");
}

/**
 * Agent names the engines define themselves (Claude's built-ins, OpenCode's
 * primary and hidden agents, Codex's built-in roles). A member with one of these ids would replace
 * the engine's own agent, so it stays a role in the lead's prompt only.
 */
const RESERVED_AGENT_IDS = new Set(["general-purpose", "explore", "plan", "statusline-setup", "output-style-setup", "build", "general", "compaction", "title", "summary", "default", "explorer", "worker", "awaiter"]);

/**
 * A team's members as subagents, in order: none for a single expert. Members
 * with a bad or reserved id are left out (the lead still sees their role).
 * A member's prompt ends with its own package skills' private index, when
 * memberSkills has one for it.
 */
export function teamAgents(def: Pick<ExpertDef, "kind" | "members">, memberSkills: Record<string, ExpertSkill[]> = {}): TeamAgent[] {
  if (def.kind !== "team" || !def.members?.length) return [];
  const seen = new Set<string>();
  const out: TeamAgent[] = [];
  for (const m of def.members) {
    if (!EXPERT_ID_RE.test(m.id) || RESERVED_AGENT_IDS.has(m.id) || seen.has(m.id) || !m.prompt.trim()) continue;
    seen.add(m.id);
    const what = [m.name, m.profession].filter(Boolean).join(", ");
    const index = skillsIndexBlock(memberSkills[m.id] ?? []);
    out.push({
      id: m.id,
      description: m.description ? `${what}: ${m.description}` : what,
      prompt: [m.prompt.slice(0, EXPERT_PROMPT_MAX), index, teamMemberProtocol(m.id)].filter(Boolean).join("\n\n"),
      ...(m.maxTurns ? { maxTurns: m.maxTurns } : {}),
      ...(m.model ? { model: m.model } : {}),
      ...(m.effort ? { effort: m.effort } : {}),
    });
  }
  return out;
}

/** A member's own model, resolved against the agent that will run the team; null when the agent ignores it. */
export function memberModelLabel(member: ExpertMember, agent: string, leadModel: string): string {
  return agentRunsMemberModel(agent) ? member.model ?? leadModel : leadModel;
}

/** The caveat under a member's model in the roster: "uses the lead's model on this agent", or "". */
export function memberModelNote(member: ExpertMember, agent: string): string {
  return member.model && !agentRunsMemberModel(agent) ? "uses the lead's model on this agent" : "";
}

/** Whether an agent runs a member on its own model: Claude and OpenCode subagents and CubiQ's provider agents do. */
function agentRunsMemberModel(agent: string): boolean {
  return agent === "claude" || agent === "opencode" || agent.startsWith("provider-");
}

/**
 * Bind a package's skills to the roles of the expert it belongs to: each team
 * member gets the skills its `skills` list names (in list order, skipping
 * names the package doesn't ship), and the lead gets whatever no member
 * claimed. A single expert gets the whole package.
 */
export function bindExpertSkills(def: Pick<ExpertDef, "kind" | "members">, pkg: ExpertSkill[]): { lead: ExpertSkill[]; members: Record<string, ExpertSkill[]> } {
  const members: Record<string, ExpertSkill[]> = {};
  if (def.kind !== "team" || !def.members?.length) return { lead: pkg, members };
  const byName = new Map(pkg.map((s) => [s.name, s]));
  const claimed = new Set<string>();
  for (const m of def.members) {
    const bound = m.skills.flatMap((name) => (byName.has(name) ? [byName.get(name)!] : []));
    if (bound.length) members[m.id] = bound;
    for (const s of bound) claimed.add(s.name);
  }
  return { lead: pkg.filter((s) => !claimed.has(s.name)), members };
}

/** What an expert import did: what it installed, what a marketplace offers to pick from, and what it skipped. */
export interface ExpertImportResult {
  installed: string[];
  candidates: { name: string; description: string; root: string }[];
  skipped: { name: string; reason: string }[];
  /** What the English pass had to drop per installed expert, when it dropped anything. */
  notes?: string[];
}
