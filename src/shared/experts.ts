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
