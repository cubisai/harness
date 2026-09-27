import { useEffect, useMemo, useState } from "react";
import type { AgentCatalogEntry, McpOverview, McpServerEntry, McpServerSpec, McpServerView, McpTestResult, SkillDetail, SkillEntry } from "../../../shared/types";
import { api } from "../api";
import { joinCommandLine, splitCommandLine } from "../cmdline";
import { IconCopy } from "../icons";
import { Markdown } from "../markdown";
import { useStore, type LibraryTab } from "../store";
import { CantDoList, CapabilityChips } from "./Capabilities";
import { UnsupportedChip } from "./UnsupportedChip";

const TABS: { id: "experts" | "skills" | "connectors"; label: string; icon: string }[] = [
  { id: "experts", label: "Experts", icon: "🧑‍💼" },
  { id: "skills", label: "Skills", icon: "🧩" },
  { id: "connectors", label: "Connectors", icon: "🔗" },
];

interface ExpertPersona {
  id: string;
  name: string;
  persona: string;
  category: string;
  avatarBg: string;
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
    avatarBg: "#10b981",
    avatarText: "CR",
    description: "Examines every line of code with eagle-eye standards, intercepting defects and module boundary violations.",
    tags: ["Code Review", "Quality Gate", "Security"],
  },
  {
    id: "ui-designer",
    name: "UI Designer",
    persona: "Sam",
    category: "Product Design",
    avatarBg: "#8b5cf6",
    avatarText: "UI",
    description: "Expert in design systems and component libraries, pursuing pixel-perfect accessible user interfaces.",
    tags: ["UI Design", "Design Systems", "Accessibility"],
  },
  {
    id: "frontend-dev",
    name: "Frontend Developer",
    persona: "Paul",
    category: "Engineering",
    avatarBg: "#3b82f6",
    avatarText: "FE",
    description: "Expert in modern web technologies, responsive SPAs, React hooks, and state management.",
    tags: ["Frontend Dev", "React", "TypeScript"],
  },
  {
    id: "diagram-expert",
    name: "Diagram Design Expert",
    persona: "Mia",
    category: "Data & AI",
    avatarBg: "#ec4899",
    avatarText: "DG",
    description: "Transforms complex software architectures and workflows into clear Mermaid and SVG diagrams.",
    tags: ["Mermaid Diagrams", "Architecture", "SVG"],
  },
  {
    id: "senior-pm",
    name: "Senior Project Manager",
    persona: "Dylan",
    category: "Project & Quality",
    avatarBg: "#f59e0b",
    avatarText: "PM",
    description: "Breaks down vague requirements into actionable milestones, specs, and risk-managed delivery plans.",
    tags: ["Project Management", "Scoping", "Milestones"],
  },
  {
    id: "data-reporter",
    name: "Data Analytics Reporter",
    persona: "Phoebe",
    category: "Data & AI",
    avatarBg: "#06b6d4",
    avatarText: "DA",
    description: "Transforms complex data into clear actionable business insights, visual charts, and executive summaries.",
    tags: ["Data Analysis", "Reporting", "Dashboards"],
  },
];

interface FeaturedConnector {
  id: string;
  name: string;
  category: string;
  iconBg: string;
  iconText: string;
  description: string;
  defaultCommand: string;
  envKey?: string;
  tags: string[];
}

const FEATURED_CONNECTORS: FeaturedConnector[] = [
  {
    id: "github",
    name: "GitHub",
    category: "Collaboration",
    iconBg: "#24292e",
    iconText: "🐙",
    description: "Clone, push, and manage repositories, issues, and pull requests with natural language.",
    defaultCommand: "npx -y @modelcontextprotocol/server-github",
    envKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
    tags: ["Git", "GitHub", "PRs"],
  },
  {
    id: "linear",
    name: "Linear",
    category: "Collaboration",
    iconBg: "#5e6ad2",
    iconText: "📐",
    description: "Manage issues, projects, cycles, and releases in Linear directly from your agent.",
    defaultCommand: "npx -y @modelcontextprotocol/server-linear",
    envKey: "LINEAR_API_KEY",
    tags: ["Linear", "Issues", "Roadmap"],
  },
  {
    id: "notion",
    name: "Notion",
    category: "Collaboration",
    iconBg: "#000000",
    iconText: "📝",
    description: "Create, search, and manage your Notion workspace databases, specifications, and docs.",
    defaultCommand: "npx -y @modelcontextprotocol/server-notion",
    envKey: "NOTION_API_TOKEN",
    tags: ["Notion", "Docs", "Wiki"],
  },
  {
    id: "canva",
    name: "Canva",
    category: "Content Creation",
    iconBg: "#00c4cc",
    iconText: "🎨",
    description: "Access Canva design capabilities: design creation, brand management, and asset exports.",
    defaultCommand: "npx -y @modelcontextprotocol/server-canva",
    envKey: "CANVA_API_KEY",
    tags: ["Canva", "Design", "Graphics"],
  },
  {
    id: "outlook",
    name: "Microsoft Outlook",
    category: "Productivity",
    iconBg: "#0078d4",
    iconText: "📧",
    description: "Read and manage Outlook email messages, calendar events, and contacts via Microsoft Graph.",
    defaultCommand: "npx -y @modelcontextprotocol/server-outlook",
    envKey: "MICROSOFT_GRAPH_TOKEN",
    tags: ["Email", "Calendar", "Office 365"],
  },
  {
    id: "browser",
    name: "Built-in Browser Tools",
    category: "Development",
    iconBg: "#0a84ff",
    iconText: "🌐",
    description: "Interactive DOM snapshots, visual clicking, text typing, and console error logs.",
    defaultCommand: "built-in",
    tags: ["Browser", "Testing", "DOM"],
  },
];

export function Library() {
  const tab = useStore((s) => s.libraryTab);
  if (!tab) return null;
  return <LibrarySheet tab={tab} />;
}

function LibrarySheet({ tab }: { tab: LibraryTab }) {
  const close = () => useStore.setState({ libraryTab: null });
  const activeTab: "experts" | "skills" | "connectors" =
    tab === "agents" ? "experts" : tab === "mcp" ? "connectors" : tab === "experts" ? "experts" : tab === "connectors" ? "connectors" : "skills";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
                <span style={{ marginRight: 6 }}>{t.icon}</span>
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
                <div className="wb-avatar" style={{ background: p.avatarBg }}>
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

          {filteredEngines.map((a) => (
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
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- 2. SKILLS TAB ----------

function SkillsTab() {
  const [all, setAll] = useState<SkillEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(useStore.getState().librarySkill);
  const [detail, setDetail] = useState<SkillDetail | null>(null);

  useEffect(() => {
    void api().listAllSkills().then(setAll);
  }, []);

  useEffect(() => {
    if (!selected && all[0]) setSelected(all[0].name);
  }, [all, selected]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    void api()
      .getSkillDetail(selected)
      .then((d) => live && setDetail(d));
    return () => {
      live = false;
    };
  }, [selected]);

  const q = query.trim().toLowerCase();
  const shown = all.filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q));
  const groups: [string, SkillEntry[]][] = [
    ["Workflow · you start these with /", shown.filter((s) => s.invocation === "user")],
    ["Loaded by the agent when the task calls for it", shown.filter((s) => s.invocation === "model")],
  ];

  if (all.length === 0) {
    return (
      <div className="wb-content-pad" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", paddingTop: 60 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🧩</div>
        <h3 style={{ margin: "0 0 8px", fontSize: 18, color: "var(--text)" }}>Clean Default State: 0 Skills Installed</h3>
        <p style={{ maxWidth: 460, color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.6, margin: "0 0 20px" }}>
          AI Harness starts clean with zero bundled skills. You can install the <strong>skilled</strong> plugin or any custom plugin into your projects.
        </p>
        <div style={{ background: "var(--bg-surface)", border: "1px solid var(--hairline)", borderRadius: 8, padding: "12px 18px", textAlign: "left", maxWidth: 500 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>To load skills via environment:</div>
          <code style={{ fontSize: 11, color: "var(--accent)" }}>export AIHARNESS_SKILLS_DIR=/path/to/ai-plugin/plugins/skilled</code>
        </div>
      </div>
    );
  }

  return (
    <div className="library-split">
      <div className="library-list">
        <input className="text-input" placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        {groups.map(([title, list]) =>
          list.length ? (
            <div key={title}>
              <div className="library-group">{title}</div>
              {list.map((s) => (
                <button key={s.name} className={`library-item${s.name === selected ? " selected" : ""}`} onClick={() => setSelected(s.name)}>
                  <span className="n">{s.invocation === "user" ? `/${s.name}` : s.name}</span>
                  <span className="d">{s.description}</span>
                </button>
              ))}
            </div>
          ) : null,
        )}
      </div>
      <div className="library-detail">{detail ? <SkillView detail={detail} onOpen={setSelected} /> : null}</div>
    </div>
  );
}

function SkillView({ detail, onOpen }: { detail: SkillDetail; onOpen: (name: string) => void }) {
  const { skill } = detail;
  const hasProject = useStore((s) => Boolean(s.selectedProjectId));
  const use = () => {
    const s = useStore.getState();
    useStore.setState({ libraryTab: null });
    if (s.selectedThreadId) useStore.setState({ pendingSkill: skill.name });
    else void s.newThread(skill.name);
  };
  return (
    <div className="skill-view">
      <div className="skill-title">
        <h3>{skill.invocation === "user" ? `/${skill.name}` : skill.name}</h3>
        <span className={`tag ${skill.invocation}`}>{skill.invocation === "user" ? "You start it" : "Agent loads it"}</span>
        <span className="grow" />
        {skill.invocation === "user" && hasProject && (
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
        <FactRow label="Invocation" value={skill.invocation === "user" ? "User: typed in prompt box with /" : "Model: loaded by agent as needed"} />
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

interface DraftState {
  name: string;
  previous: string | null;
  type: McpServerSpec["type"];
  line: string;
  url: string;
  pairs: { key: string; value: string }[];
}

function emptyDraft(): DraftState {
  return { name: "", previous: null, type: "stdio", line: "", url: "", pairs: [] };
}

function ConnectorsTab() {
  const [data, setData] = useState<McpOverview | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, McpTestResult | "running">>({});
  const projectId = useStore((s) => s.selectedProjectId);

  const refresh = () => void api().getMcp(projectId).then(setData);
  useEffect(refresh, [projectId]);

  const quickConnect = (fc: FeaturedConnector) => {
    if (fc.defaultCommand === "built-in") return;
    setDraft({
      name: fc.id,
      previous: null,
      type: "stdio",
      line: fc.defaultCommand,
      url: "",
      pairs: fc.envKey ? [{ key: fc.envKey, value: "" }] : [],
    });
    setError(null);
  };

  const save = async () => {
    if (!draft) return;
    setError(null);
    const name = draft.name.trim();
    if (!name) return setError("Name is required.");
    let spec: McpServerSpec;
    if (draft.type === "stdio") {
      const parts = splitCommandLine(draft.line.trim());
      if (!parts.length) return setError("Command is required.");
      const env: Record<string, string> = {};
      for (const p of draft.pairs) if (p.key.trim() && p.value !== "") env[p.key.trim()] = p.value;
      spec = { type: "stdio", command: parts[0]!, args: parts.slice(1), env: Object.keys(env).length ? env : undefined };
    } else {
      const url = draft.url.trim();
      if (!url) return setError("URL is required.");
      const headers: Record<string, string> = {};
      for (const p of draft.pairs) if (p.key.trim() && p.value !== "") headers[p.key.trim()] = p.value;
      spec = { type: "http", url, headers: Object.keys(headers).length ? headers : undefined };
    }
    try {
      const updated = await api().saveMcpServer({ name, spec, enabled: true }, draft.previous ?? undefined);
      setData(updated);
      setDraft(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const test = async (name: string) => {
    setTests((t) => ({ ...t, [name]: "running" }));
    const res = await api().testMcpServer(name);
    setTests((t) => ({ ...t, [name]: res }));
  };

  if (!data) return <div className="library-pad" />;

  const installedNames = new Set(data.servers.map((s) => s.name.toLowerCase()));

  return (
    <div className="wb-content-pad">
      <div style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: "0 0 6px" }}>Featured Connectors (1-Click Connect)</h3>
        <p className="note" style={{ margin: "0 0 12px" }}>Popular Model Context Protocol (MCP) integrations for tools, tasks, and external services.</p>
        <div className="wb-grid">
          {FEATURED_CONNECTORS.map((fc) => {
            const isConnected = installedNames.has(fc.id.toLowerCase());
            return (
              <div key={fc.id} className="wb-card">
                <div className="wb-card-header">
                  <div className="wb-avatar" style={{ background: fc.iconBg }}>
                    {fc.iconText}
                  </div>
                  <div className="wb-card-meta">
                    <h4 className="wb-card-title">{fc.name}</h4>
                    <div className="wb-card-sub">{fc.category}</div>
                  </div>
                </div>
                <p className="wb-card-desc">{fc.description}</p>
                <div className="wb-card-footer">
                  <div className="wb-tags">
                    {fc.tags.map((t) => (
                      <span key={t} className="wb-tag">{t}</span>
                    ))}
                  </div>
                  {fc.defaultCommand !== "built-in" ? (
                    <button
                      className={`button wb-action-btn ${isConnected ? "ghost" : "primary"}`}
                      onClick={() => quickConnect(fc)}
                    >
                      {isConnected ? "Configured" : "+ Connect"}
                    </button>
                  ) : (
                    <span className="tag" style={{ fontSize: 11 }}>Active in Browser</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <section style={{ borderTop: "1px solid var(--hairline)", paddingTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Configured MCP Servers</h3>
          {!draft && (
            <button className="button" onClick={() => setDraft(emptyDraft())}>
              + Add Custom Server
            </button>
          )}
        </div>

        {draft && (
          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--hairline)", borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <McpForm draft={draft} setDraft={setDraft} error={error} onSave={() => void save()} onCancel={() => (setDraft(null), setError(null))} />
          </div>
        )}

        {data.servers.length === 0 && !draft ? (
          <p className="note">No custom servers configured yet. Pick one from Featured Connectors above or click &quot;+ Add Custom Server&quot;.</p>
        ) : (
          data.servers.map((s) => {
            const t = tests[s.name];
            return (
              <div key={s.name} className={`mcp-row${s.enabled ? "" : " off"}`}>
                <label className="switch" title={s.enabled ? "On" : "Off"}>
                  <input type="checkbox" checked={s.enabled} onChange={(e) => void api().setMcpServerEnabled(s.name, e.target.checked).then(refresh)} />
                  <span />
                </label>
                <div className="mcp-main">
                  <div className="mcp-name">
                    {s.name} <span className="tag">{s.type === "http" ? "URL" : "Command"}</span>
                  </div>
                  <code className="mcp-target">{s.target}</code>
                  {(s.envKeys.length > 0 || s.headerKeys.length > 0) && <div className="mcp-keys">{[...s.envKeys, ...s.headerKeys].join(" · ")}</div>}
                  {t && t !== "running" && (
                    <div className={`mcp-test ${t.ok ? "ok" : "bad"}`}>
                      {t.ok ? `Connected · ${t.tools.length} tool${t.tools.length === 1 ? "" : "s"}` : `Couldn't connect: ${t.error}`}
                    </div>
                  )}
                </div>
                <button className="button ghost" disabled={t === "running"} onClick={() => void test(s.name)}>
                  {t === "running" ? "Testing…" : "Test"}
                </button>
                <button className="button ghost danger" onClick={() => void api().removeMcpServer(s.name).then(refresh)}>
                  Remove
                </button>
              </div>
            );
          })
        )}
      </section>

      <section style={{ borderTop: "1px solid var(--hairline)", paddingTop: 16, marginTop: 16 }}>
        <h3>Built in</h3>
        <div className="mcp-row">
          <div className="mcp-main">
            <div className="mcp-name">
              {data.builtIn.name} <span className="tag">{data.builtIn.active ? "Active" : "Starts with Browser pane"}</span>
            </div>
            <div className="mcp-tools">
              {data.builtIn.tools.map((t) => (
                <span key={t.name} className="chip mono" title={t.description}>
                  {t.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function McpForm({
  draft,
  setDraft,
  error,
  onSave,
  onCancel,
}: {
  draft: DraftState;
  setDraft: React.Dispatch<React.SetStateAction<DraftState | null>>;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<DraftState>) => setDraft((d) => (d ? { ...d, ...patch } : null));
  const pairLabel = draft.type === "http" ? "Headers" : "Env";

  return (
    <form
      className="mcp-form editing"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="row">
        <span className="label">Name</span>
        <input className="text-input" autoFocus value={draft.name} placeholder="github" spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="row">
        <span className="label">Runs as</span>
        <div className="segmented">
          <button type="button" className={draft.type === "stdio" ? "on" : ""} onClick={() => set({ type: "stdio" })}>
            Command
          </button>
          <button type="button" className={draft.type === "http" ? "on" : ""} onClick={() => set({ type: "http" })}>
            URL
          </button>
        </div>
      </div>
      {draft.type === "stdio" ? (
        <div className="row">
          <span className="label">Command</span>
          <input className="text-input mono" value={draft.line} placeholder="npx -y @modelcontextprotocol/server-github" spellCheck={false} onChange={(e) => set({ line: e.target.value })} />
        </div>
      ) : (
        <div className="row">
          <span className="label">URL</span>
          <input className="text-input mono" value={draft.url} placeholder="https://mcp.example.com/mcp" spellCheck={false} onChange={(e) => set({ url: e.target.value })} />
        </div>
      )}
      {draft.pairs.map((p, i) => (
        <div className="row" key={i}>
          <span className="label">{i === 0 ? pairLabel : ""}</span>
          <input
            className="text-input mono pair-key"
            value={p.key}
            placeholder={draft.type === "http" ? "Authorization" : "TOKEN"}
            spellCheck={false}
            onChange={(e) => set({ pairs: draft.pairs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
          />
          <input
            className="text-input mono"
            type="password"
            autoComplete="off"
            value={p.value}
            placeholder={draft.previous ? "unchanged" : "value"}
            onChange={(e) => set({ pairs: draft.pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
          />
          <button type="button" className="button ghost" onClick={() => set({ pairs: draft.pairs.filter((_, j) => j !== i) })}>
            Remove
          </button>
        </div>
      ))}
      <div className="row">
        <span className="label">{draft.pairs.length ? "" : pairLabel}</span>
        <button type="button" className="button ghost" onClick={() => set({ pairs: [...draft.pairs, { key: "", value: "" }] })}>
          Add {draft.type === "http" ? "Header" : "Variable"}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="row end">
        <button type="button" className="button ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button primary">
          {draft.previous ? "Save" : "Add Server"}
        </button>
      </div>
    </form>
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
