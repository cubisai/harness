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
  /** A design system id; absent = the project's default. */
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
    skills: ["design-prototype"],
    designSystem: "clean",
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
    skills: ["design-mobile"],
    designSystem: "clean",
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
    skills: ["design-slides"],
    designSystem: "editorial",
  },
  {
    id: "design-system-architect",
    name: "Design-System Architect",
    persona: "Theo",
    category: "Design",
    avatarText: "DS",
    description: "Extracts a design system from a site, a screenshot or your code into DESIGN.md and tokens you can design with.",
    tags: ["Tokens", "DESIGN.md", "Extraction"],
    kind: "design",
    skills: ["design-system-extract"],
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
    skills: ["design-critique"],
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
  };
}

/**
 * The text injected into an agent's instructions for a thread's expert: the
 * persona prompt wrapped in an `<expert>` block, and, for a team, its members.
 * Double quotes in attributes are escaped so the markup stays well-formed.
 */
export function expertBlock(def: Pick<ExpertDef, "name" | "profession" | "prompt" | "kind" | "members">): string {
  const attr = (value: string) => value.replace(/"/g, "&quot;");
  const head = `<expert name="${attr(def.name)}" role="${attr(def.profession)}">`;
  const body = `${head}\n${def.prompt}\n</expert>`;
  if (def.kind !== "team" || !def.members?.length) return body;
  const lines = def.members.map((m) => `- \`${m.id}\` — ${m.name}, ${m.profession}: ${m.description}`);
  return [
    body,
    "## Your team",
    lines.join("\n"),
    "Hand independent steps to members in parallel, keep dependent steps in order, then consolidate their outputs into one answer.",
  ].join("\n\n");
}

/** What an expert import did: what it installed, what a marketplace offers to pick from, and what it skipped. */
export interface ExpertImportResult {
  installed: string[];
  candidates: { name: string; description: string; root: string }[];
  skipped: { name: string; reason: string }[];
}
