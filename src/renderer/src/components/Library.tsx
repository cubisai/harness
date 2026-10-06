import { useEffect, useMemo, useState } from "react";
import { Brain, BriefcaseBusiness, Plug, Puzzle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentCatalogEntry, SkillDetail, SkillEntry, SkillOrigin } from "../../../shared/types";
import { api } from "../api";
import { IconCopy } from "../icons";
import { Markdown } from "../markdown";
import { useStore, type LibraryTab } from "../store";
import { CantDoList, CapabilityChips, BinaryLine } from "./Capabilities";
import { McpPanel } from "./McpPanel";
import { MemoryTab } from "./MemoryTab";
import { Select, selectPopupOpen } from "./Select";
import { UnsupportedChip } from "./UnsupportedChip";

const TABS: { id: "experts" | "skills" | "connectors" | "memory"; label: string; icon: LucideIcon }[] = [
  { id: "experts", label: "Experts", icon: BriefcaseBusiness },
  { id: "skills", label: "Skills", icon: Puzzle },
  { id: "connectors", label: "Connectors", icon: Plug },
  { id: "memory", label: "Memory", icon: Brain },
];

interface ExpertPersona {
  id: string;
  name: string;
  persona: string;
  category: string;
  avatarText: string;
  description: string;
  tags: string[];
}

const EXPERT_PERSONAS: ExpertPersona[] = [
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
    id: "ui-designer",
    name: "UI Designer",
    persona: "Sam",
    category: "Product Design",
    avatarText: "UI",
    description: "Expert in design systems and component libraries, pursuing pixel-perfect accessible user interfaces.",
    tags: ["UI Design", "Design Systems", "Accessibility"],
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

export function Library() {
  const tab = useStore((s) => s.libraryTab);
  if (!tab) return null;
  return <LibrarySheet tab={tab} />;
}

function LibrarySheet({ tab }: { tab: LibraryTab }) {
  const close = () => useStore.setState({ libraryTab: null });
  const activeTab: "experts" | "skills" | "connectors" | "memory" =
    tab === "agents" ? "experts" : tab === "mcp" ? "connectors" : tab === "experts" ? "experts" : tab === "connectors" ? "connectors" : tab === "memory" ? "memory" : "skills";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // An open pick list takes Escape for itself.
      if (e.key === "Escape" && selectPopupOpen()) return;
      if (e.key === "Escape" && !document.querySelector(".library .editing")) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="library" role="dialog" aria-modal="true" aria-label="Library">
        <div className="library-head">
          <h2>Library</h2>
          <div className="segmented" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={activeTab === t.id}
                className={activeTab === t.id ? "on" : ""}
                onClick={() => useStore.setState({ libraryTab: t.id })}
              >
                <span style={{ display: "inline-flex", marginRight: 6, verticalAlign: "-2px" }}>
                  <t.icon size={14} strokeWidth={1.75} aria-hidden />
                </span>
                {t.label}
              </button>
            ))}
          </div>
          <button className="button ghost" onClick={close}>
            Done
          </button>
        </div>
        {activeTab === "experts" && <ExpertsTab />}
        {activeTab === "skills" && <SkillsTab />}
        {activeTab === "connectors" && <ConnectorsTab />}
        {activeTab === "memory" && <MemoryTab />}
      </div>
    </div>
  );
}

// ---------- 1. EXPERTS TAB ----------

function ExpertsTab() {
  const [agents, setAgents] = useState<AgentCatalogEntry[] | null>(null);
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const hasProject = useStore((s) => Boolean(s.selectedProjectId));
  const running = useStore((s) => s.agents);

  useEffect(() => {
    void api().listAgentCatalog().then(setAgents);
  }, []);

  const categories = ["All", "Engineering", "Product Design", "Data & AI", "Project & Quality", "Engines"];

  const filteredPersonas = useMemo(() => {
    const q = search.trim().toLowerCase();
    return EXPERT_PERSONAS.filter((p) => {
      const matchCat = selectedCategory === "All" || p.category === selectedCategory;
      const matchQ = !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.persona.toLowerCase().includes(q);
      return matchCat && matchQ;
    });
  }, [selectedCategory, search]);

  const filteredEngines = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!agents) return [];
    if (selectedCategory !== "All" && selectedCategory !== "Engines") return [];
    return agents.filter((a) => !q || a.label.toLowerCase().includes(q) || a.skills.toLowerCase().includes(q));
  }, [agents, selectedCategory, search]);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };

  const startThreadWithExpert = (name: string) => {
    const s = useStore.getState();
    useStore.setState({ libraryTab: null });
    void s.newThread();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div className="library-toolbar">
        <input
          className="text-input library-search-input"
          placeholder="Search expert title, persona, or specialty…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="category-pills">
        {categories.map((c) => (
          <button key={c} className={`category-pill${selectedCategory === c ? " on" : ""}`} onClick={() => setSelectedCategory(c)}>
            {c}
          </button>
        ))}
      </div>

      <div className="wb-content-pad">
        <div className="wb-grid">
          {filteredPersonas.map((p) => (
            <div key={p.id} className="wb-card">
              <div className="wb-card-header">
                <div className="wb-avatar">
                  {p.avatarText}
                </div>
                <div className="wb-card-meta">
                  <h4 className="wb-card-title">{p.name}</h4>
                  <div className="wb-card-sub">{p.persona} · {p.category}</div>
                </div>
              </div>
              <p className="wb-card-desc">{p.description}</p>
              <div className="wb-card-footer">
                <div className="wb-tags">
                  {p.tags.map((t) => (
                    <span key={t} className="wb-tag">{t}</span>
                  ))}
                </div>
                {hasProject && (
                  <button className="button primary wb-action-btn" onClick={() => startThreadWithExpert(p.name)}>
                    Start Thread
                  </button>
                )}
              </div>
            </div>
          ))}

          {filteredEngines.map((a) => {
            const binary = running.find((r) => r.id === a.id)?.binary;
            return (
            <div key={a.id} className={`wb-card${a.installed ? "" : " missing"}`}>
              <div className="wb-card-header">
                <div className="wb-avatar" style={{ background: a.installed ? "#4f46e5" : "#64748b" }}>
                  {a.label.slice(0, 2).toUpperCase()}
                </div>
                <div className="wb-card-meta">
                  <h4 className="wb-card-title">{a.label}</h4>
                  <div className="wb-card-sub">Base Engine · {a.kind}</div>
                </div>
              </div>
              {a.unsupported && <UnsupportedChip note={a.unsupported} />}
              <p className="wb-card-desc">{a.skills || a.mcp || "AI Coding Agent"}</p>
              {a.capabilities && (
                <>
                  <CapabilityChips capabilities={a.capabilities} />
                  <CantDoList capabilities={a.capabilities} />
                </>
              )}
              {binary && <BinaryLine binary={binary} />}
              <div className="wb-card-footer">
                <div className="wb-tags">
                  <span className="wb-tag">{a.installed ? "Installed" : "Not Installed"}</span>
                  {a.optIn && !running.some((r) => r.id === a.id) && (
                    <span className="wb-tag" title="Settings → Agents & Providers">
                      Off until you opt in
                    </span>
                  )}
                </div>
                {!a.installed && a.install ? (
                  <button className="button ghost wb-action-btn" onClick={() => copy(a.install!)}>
                    {copied === a.install ? "Copied" : "Copy Install"}
                  </button>
                ) : (
                  hasProject && (
                    <button className="button ghost wb-action-btn" onClick={() => startThreadWithExpert(a.label)}>
                      Start Thread
                    </button>
                  )
                )}
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- 2. SKILLS TAB ----------

/** Where a skill came from, as the Library and the $ menu label it. */
export function originLabel(origin?: SkillOrigin): string {
  switch (origin) {
    case "project":
    case "projectClaude":
      return "Project";
    case "harness":
      return "Global (CubiQ)";
    case "shared":
      // Kept for old data: the shared layer is no longer a catalog source.
      return "Shared (~/.agents)";
    case "bundled":
      return "Built-in";
    default:
      return "Library";
  }
}

/** A skill's selection key; names can repeat across origins. */
function skillKey(s: SkillEntry): string {
  return `${s.origin ?? "legacy"}:${s.name}`;
}

const SKILL_ORIGINS: SkillOrigin[] = ["project", "harness", "bundled", "legacy"];

function SkillsTab() {
  const projectId = useStore((s) => s.selectedProjectId);
  const [all, setAll] = useState<SkillEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(useStore.getState().librarySkill);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [form, setForm] = useState<{ name: string; description: string; scope: "harness" | "project" } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [folders, setFolders] = useState<{ project: string; projectClaude: string; harness: string; bundled: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = () => void api().listAllSkills(projectId ?? undefined).then(setAll);
  useEffect(reload, [projectId]);

  // A bare name (from the store) resolves to the first matching origin's key.
  useEffect(() => {
    if (!all.length) return;
    setSelected((cur) => {
      if (cur && all.some((s) => skillKey(s) === cur)) return cur;
      const match = cur ? all.find((s) => s.name === cur) : undefined;
      return skillKey(match ?? all[0]!);
    });
  }, [all]);

  const picked = selected ? all.find((s) => skillKey(s) === selected) : undefined;
  useEffect(() => {
    if (!picked) {
      setDetail(null);
      return;
    }
    let live = true;
    void api()
      .getSkillDetail(picked.name, projectId ?? undefined)
      .then((d) => live && setDetail(d));
    return () => {
      live = false;
    };
  }, [picked?.name, projectId]);

  const q = query.trim().toLowerCase();
  const shown = all.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  // Both project folders list together under Project.
  const groupOf = (s: SkillEntry) => (s.origin === "projectClaude" ? "project" : (s.origin ?? "legacy"));
  const groups = SKILL_ORIGINS.map((origin) => [origin, shown.filter((s) => groupOf(s) === origin)] as const);

  const open = (name: string) => {
    const entry = all.find((s) => s.name === name);
    if (entry) setSelected(skillKey(entry));
  };

  const toggleForm = () => {
    setForm((f) => (f ? null : { name: "", description: "", scope: "harness" }));
    setFormError(null);
  };

  const toggleFolders = () => {
    if (folders) return setFolders(null);
    void api().getSkillFolders(projectId ?? undefined).then(setFolders);
  };

  const create = async () => {
    if (!form) return;
    setFormError(null);
    setCreating(true);
    try {
      const name = form.name.trim();
      const origin: SkillOrigin = form.scope;
      const path = await api().createSkill({ scope: form.scope, projectId, name, description: form.description.trim() });
      setForm(null);
      setSelected(`${origin}:${name}`);
      reload();
      await api().revealPath(path);
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setCreating(false);
    }
  };

  const newForm = form ? (
    <form
      className="skill-new-form"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <input className="text-input" autoFocus value={form.name} placeholder="release-notes" spellCheck={false} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <textarea className="text-input" rows={2} value={form.description} placeholder="What it does, then: Use when …" onChange={(e) => setForm({ ...form, description: e.target.value })} />
      <Select
        className="block"
        value={form.scope}
        options={[
          { value: "harness", label: "Global (CubiQ)" },
          { value: "project", label: "This project", disabled: !projectId },
        ]}
        onChange={(v) => setForm({ ...form, scope: v })}
        ariaLabel="Scope"
      />
      {formError && <p className="form-error">{formError}</p>}
      <div className="skill-new-actions">
        <button type="button" className="button ghost" onClick={toggleForm}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={creating}>
          Create
        </button>
      </div>
    </form>
  ) : null;

  const folderList = folders ? (
    <div className="skill-folders">
      {(
        [
          ["project", folders.project],
          ["project", folders.projectClaude],
          ["harness", folders.harness],
          ["bundled", folders.bundled],
        ] as [SkillOrigin, string][]
      )
        .filter(([, path]) => path)
        .map(([origin, path]) => (
          <button key={path} className="file-link" onClick={() => void api().revealPath(path)}>
            {originLabel(origin)} <code>{path}</code>
          </button>
        ))}
    </div>
  ) : null;

  if (all.length === 0) {
    return (
      <div className="wb-content-pad" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", paddingTop: 60 }}>
        <Puzzle size={32} strokeWidth={1.5} aria-hidden style={{ color: "var(--text-tertiary)", marginBottom: 12 }} />
        <h3 style={{ margin: "0 0 8px", fontSize: 18, color: "var(--text)" }}>No skills yet</h3>
        <p style={{ maxWidth: 460, color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.6, margin: "0 0 20px" }}>
          Add a skill folder with a SKILL.md, or create one here.
        </p>
        <button className="button" onClick={toggleForm}>
          New skill
        </button>
        <div style={{ width: "100%", maxWidth: 460, textAlign: "left", marginTop: 12 }}>{newForm}</div>
      </div>
    );
  }

  return (
    <div className="library-split">
      <div className="library-list">
        <div className="skill-toolbar">
          <button className="button" onClick={toggleForm}>
            New skill
          </button>
          <button className="button" onClick={toggleFolders}>
            Folders
          </button>
        </div>
        {newForm}
        {folderList}
        <input className="text-input" placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        {groups.map(([origin, list]) =>
          list.length ? (
            <div key={origin}>
              <div className="library-group">{originLabel(origin)}</div>
              {list.map((s) => {
                const key = skillKey(s);
                const off = s.enabled === false;
                const shadowed = Boolean(s.shadowedBy);
                return (
                  <div
                    key={key}
                    role="button"
                    tabIndex={0}
                    className={`library-item with-switch${key === selected ? " selected" : ""}${off ? " off" : ""}${shadowed ? " shadowed" : ""}`}
                    onClick={() => setSelected(key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(key);
                      }
                    }}
                  >
                    <span className="library-item-text">
                      <span className="n">{s.invocation === "user" ? `$${s.name}` : s.name}</span>
                      <span className="d">{s.description}</span>
                      {shadowed && <span className="shadow-note">Overridden by {originLabel(s.shadowedBy)}</span>}
                    </span>
                    <input
                      type="checkbox"
                      className="skill-switch"
                      checked={s.enabled !== false}
                      onChange={() => void api().setSkillEnabled(s.origin ?? "legacy", s.name, s.enabled === false).then(() => reload())}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Use ${s.name}`}
                    />
                  </div>
                );
              })}
            </div>
          ) : null,
        )}
      </div>
      <div className="library-detail">{detail ? <SkillView detail={detail} onOpen={open} /> : null}</div>
    </div>
  );
}

function SkillView({ detail, onOpen }: { detail: SkillDetail; onOpen: (name: string) => void }) {
  const { skill } = detail;
  const hasProject = useStore((s) => Boolean(s.selectedProjectId));
  const use = () => {
    const s = useStore.getState();
    useStore.setState({ libraryTab: null });
    if (s.selectedThreadId) s.addPendingSkills([skill.name]);
    else void s.newThread([skill.name]);
  };
  return (
    <div className="skill-view">
      <div className="skill-title">
        <h3>{skill.invocation === "user" ? `$${skill.name}` : skill.name}</h3>
        <span className={`tag ${skill.invocation}`}>
          {skill.invocation === "user" ? "You start it with $" : "The agent loads it when the task matches (you can also start it with $)"}
        </span>
        <span className="tag">{originLabel(skill.origin)}</span>
        <span className="grow" />
        {hasProject && (
          <button className="button primary" onClick={use}>
            Use in Thread
          </button>
        )}
        {detail.dir && (
          <button className="button" onClick={() => void api().revealPath(`${detail.dir}/SKILL.md`)}>
            Show in Folder
          </button>
        )}
      </div>
      <p className="skill-desc">{skill.description}</p>
      <dl className="facts">
        {skill.argumentHint && <FactRow label="Arguments" value={skill.argumentHint} mono />}
        <FactRow label="Invocation" value={skill.invocation === "user" ? "User: typed in prompt box with $" : "Model: loaded by agent as needed"} />
        {detail.calledBy.length > 0 && (
          <>
            <dt>Called By</dt>
            <dd className="chips">
              {detail.calledBy.map((n) => (
                <button key={n} className="chip mono" onClick={() => onOpen(n)}>
                  {n}
                </button>
              ))}
            </dd>
          </>
        )}
        {skill.calls.length > 0 && (
          <>
            <dt>Calls</dt>
            <dd className="chips">
              {skill.calls.map((n) => (
                <button key={n} className="chip mono" onClick={() => onOpen(n)}>
                  {n}
                </button>
              ))}
            </dd>
          </>
        )}
        {skill.compatibility && <FactRow label="Requires" value={skill.compatibility} />}
        {detail.routes.length > 0 && (
          <>
            <dt>Agent Route</dt>
            <dd>
              {detail.routes.map((r) => (
                <div key={r.agent} style={{ margin: "2px 0" }}>
                  <strong>{r.agent}:</strong> {r.how}
                </div>
              ))}
            </dd>
          </>
        )}
      </dl>
      <div className="skill-body">
        <Markdown text={detail.body} />
      </div>
    </div>
  );
}

// ---------- 3. CONNECTORS TAB ----------

function ConnectorsTab() {
  return (
    <div className="wb-content-pad">
      <McpPanel />
    </div>
  );
}

function FactRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? "mono" : ""}>{value}</dd>
    </>
  );
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
