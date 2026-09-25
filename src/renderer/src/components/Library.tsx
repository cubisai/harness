import { useEffect, useMemo, useState } from "react";
import type { AgentCatalogEntry, McpOverview, McpServerEntry, McpServerView, McpTestResult, SkillDetail, SkillEntry } from "../../../shared/types";
import { api } from "../api";
import { joinCommandLine, splitCommandLine } from "../cmdline";
import { IconCopy } from "../icons";
import { Markdown } from "../markdown";
import { useStore, type LibraryTab } from "../store";

const TABS: { id: LibraryTab; label: string }[] = [
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP Servers" },
  { id: "agents", label: "Agents" },
];

/** What the agents get: skills, MCP servers, and the agents themselves, in one place. */
export function Library() {
  const tab = useStore((s) => s.libraryTab);
  if (!tab) return null;
  return <LibrarySheet tab={tab} />;
}

function LibrarySheet({ tab }: { tab: LibraryTab }) {
  const close = () => useStore.setState({ libraryTab: null });
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
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => useStore.setState({ libraryTab: t.id })}>
                {t.label}
              </button>
            ))}
          </div>
          <button className="button ghost" onClick={close}>
            Done
          </button>
        </div>
        {tab === "skills" && <SkillsTab />}
        {tab === "mcp" && <McpTab />}
        {tab === "agents" && <AgentsTab />}
      </div>
    </div>
  );
}

// ---------- skills ----------

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
        <button className="button" onClick={() => void api().revealPath(`${detail.dir}/SKILL.md`)}>
          Show in Folder
        </button>
      </div>
      <p className="skill-desc">{skill.description}</p>
      <dl className="facts">
        {skill.argumentHint && (
          <>
            <dt>Takes</dt>
            <dd>
              <code>{skill.argumentHint}</code>
            </dd>
          </>
        )}
        {skill.compatibility && (
          <>
            <dt>Needs</dt>
            <dd>{skill.compatibility}</dd>
          </>
        )}
        {skill.calls.length > 0 && (
          <>
            <dt>Calls</dt>
            <dd className="chips">
              {skill.calls.map((c) => (
                <button key={c} className="chip" onClick={() => onOpen(c)}>
                  {c}
                </button>
              ))}
            </dd>
          </>
        )}
        {detail.calledBy.length > 0 && (
          <>
            <dt>Called by</dt>
            <dd className="chips">
              {detail.calledBy.map((c) => (
                <button key={c} className="chip" onClick={() => onOpen(c)}>
                  {c}
                </button>
              ))}
            </dd>
          </>
        )}
        <dt>Files</dt>
        <dd className="chips">
          {skill.files.map((f) => (
            <button key={f} className="chip mono" title="Show in folder" onClick={() => void api().revealPath(`${detail.dir}/${f}`)}>
              {f}
            </button>
          ))}
        </dd>
        {detail.routes.map((r) => (
          <FactRow key={r.agent} label={r.agent} value={r.how} />
        ))}
      </dl>
      <div className="skill-body">
        <Markdown text={detail.body} />
      </div>
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

// ---------- MCP ----------

type Draft = { name: string; type: "stdio" | "http"; line: string; url: string; pairs: { key: string; value: string }[]; previous?: string };

const emptyDraft = (): Draft => ({ name: "", type: "stdio", line: "", url: "", pairs: [] });

function McpTab() {
  const projectId = useStore((s) => s.selectedProjectId);
  const [data, setData] = useState<McpOverview | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, McpTestResult | "running">>({});

  useEffect(() => {
    void api().getMcp(projectId).then(setData);
  }, [projectId]);
  const refresh = (o: McpOverview) => setData({ ...o, external: data?.external ?? o.external });

  const save = async () => {
    if (!draft) return;
    const words = splitCommandLine(draft.line);
    const map = Object.fromEntries(draft.pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]));
    const entry: McpServerEntry = {
      name: draft.name.trim(),
      enabled: true,
      spec:
        draft.type === "http"
          ? { type: "http", url: draft.url, headers: map }
          : { type: "stdio", command: words[0] ?? "", args: words.slice(1), env: map },
    };
    try {
      refresh(await api().saveMcpServer(entry, draft.previous));
      setDraft(null);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const test = async (name: string) => {
    setTests((t) => ({ ...t, [name]: "running" }));
    const res = await api().testMcpServer(name);
    setTests((t) => ({ ...t, [name]: res }));
  };

  const edit = (s: McpServerView) =>
    setDraft({
      name: s.name,
      previous: s.name,
      type: s.type,
      line: s.type === "stdio" ? s.target : "",
      url: s.type === "http" ? s.target : "",
      pairs: (s.type === "stdio" ? s.envKeys : s.headerKeys).map((key) => ({ key, value: "" })),
    });

  if (!data) return <div className="library-pad" />;
  const byAgent = new Map<string, typeof data.external>();
  for (const e of data.external) byAgent.set(e.agent, [...(byAgent.get(e.agent) ?? []), e]);

  return (
    <div className="library-pad">
      <section>
        <h3>Your servers</h3>
        <p className="note">Given to every agent in every thread, alongside the agent's own. Stdio servers reach every agent; URL servers reach agents that support HTTP MCP.</p>
        {data.servers.map((s) => {
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
                    {t.ok ? `Connected · ${t.tools.length} tool${t.tools.length === 1 ? "" : "s"}${t.tools.length ? `: ${t.tools.map((x) => x.name).join(", ")}` : ""}` : `Couldn't connect: ${t.error}`}
                  </div>
                )}
              </div>
              <button className="button ghost" disabled={t === "running"} onClick={() => void test(s.name)}>
                {t === "running" ? "Testing…" : "Test"}
              </button>
              <button className="button ghost" onClick={() => edit(s)}>
                Edit
              </button>
              <button className="button ghost danger" onClick={() => void api().removeMcpServer(s.name).then(refresh)}>
                Remove
              </button>
            </div>
          );
        })}
        {draft ? (
          <McpForm draft={draft} setDraft={setDraft} error={error} onSave={() => void save()} onCancel={() => (setDraft(null), setError(null))} />
        ) : (
          <button className="button" onClick={() => setDraft(emptyDraft())}>
            Add Server…
          </button>
        )}
      </section>

      <section>
        <h3>Built in</h3>
        <div className="mcp-row">
          <div className="mcp-main">
            <div className="mcp-name">
              {data.builtIn.name} <span className="tag">{data.builtIn.active ? "Active" : "Starts with the Browser tab"}</span>
            </div>
            <div className="mcp-tools">
              {data.builtIn.tools.map((t) => (
                <div key={t.name} title={t.description}>
                  <code>{t.name}</code>
                  {!t.autoAllow && <span className="tag">asks first in Ask mode</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section>
        <h3>Loaded by the agents themselves</h3>
        {byAgent.size === 0 ? (
          <p className="note">None found in Claude Code, Codex, Gemini, or OpenCode's config.</p>
        ) : (
          [...byAgent].map(([agent, list]) => (
            <div key={agent} className="mcp-external">
              <div className="library-group">{agent}</div>
              {list.map((e) => (
                <div key={`${e.source}/${e.name}`} className="mcp-row readonly">
                  <div className="mcp-main">
                    <div className="mcp-name">
                      {e.name} <span className="tag">{e.type === "stdio" ? "Command" : e.type === "unknown" ? "?" : "URL"}</span>
                    </div>
                    <code className="mcp-target">{e.target}</code>
                  </div>
                  <span className="mcp-source">{e.source}</span>
                </div>
              ))}
            </div>
          ))
        )}
      </section>
      <p className="note">
        Your servers live in <code>{data.file}</code>, in the same shape as Claude Code's .mcp.json.
      </p>
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
  draft: Draft;
  setDraft: (d: Draft) => void;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const pairLabel = draft.type === "http" ? "Headers" : "Environment";
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
            placeholder={draft.type === "http" ? "Authorization" : "GITHUB_TOKEN"}
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

function errorText(err: unknown): string {
  // ipcRenderer.invoke wraps main-process errors: "Error invoking remote method 'x': Error: message".
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

// ---------- agents ----------

const KIND: Record<AgentCatalogEntry["kind"], string> = { "agent-sdk": "Agent SDK", "app-server": "App server", acp: "ACP" };

function AgentsTab() {
  const [agents, setAgents] = useState<AgentCatalogEntry[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    void api().listAgentCatalog().then(setAgents);
  }, []);
  const sorted = useMemo(() => [...(agents ?? [])].sort((a, b) => Number(b.installed) - Number(a.installed)), [agents]);
  if (!agents) return <div className="library-pad" />;
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };
  return (
    <div className="library-pad agent-cards">
      {sorted.map((a) => (
        <div key={a.id} className={`agent-card${a.installed ? "" : " missing"}`}>
          <div className="agent-head">
            <strong>{a.label}</strong>
            <span className="tag">{KIND[a.kind]}</span>
            {a.source === "agents.json" && <span className="tag">agents.json</span>}
            <span className="grow" />
            {a.installed ? <span className="ok-text">Installed</span> : <span className="muted">Not installed</span>}
          </div>
          <dl className="facts">
            {a.command && <FactRow label="Runs" value={a.command} />}
            <FactRow label="Skills" value={a.skills} />
            <FactRow label="MCP" value={a.mcp} />
            {!a.installed && a.install && (
              <>
                <dt>Install</dt>
                <dd>
                  <button className="install-line" title="Copy" onClick={() => copy(a.install!)}>
                    <code>{a.install}</code> <IconCopy /> {copied === a.install ? "Copied" : ""}
                  </button>
                </dd>
              </>
            )}
          </dl>
        </div>
      ))}
      <p className="note">Agents appear in the thread header once installed (restart the app after installing). Add any other ACP agent in agents.json in the data folder.</p>
    </div>
  );
}
