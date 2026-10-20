import { useEffect, useRef, useState } from "react";
import type { Project, Thread } from "../../../shared/types";
import { IconChevron, IconCompose, IconFolder, IconGear, IconLibrary, IconMore, IconPlus, IconSearch } from "../icons";
import { api } from "../api";
import { elapsed, inboxModel, shortTime, waitingThreads } from "../sections";
import { ThreadRow, type ThreadStatus } from "./ThreadRow";
import { useStore } from "../store";
import { InboxBell } from "./MessageCenter";
import { ModeToggle, SidebarToggle } from "./PaneRail";
import { Select } from "./Select";

/** A project as a small folder label: toggles its group, + starts a thread, ⋯ opens its menu. */
function ProjectRow({
  project,
  open,
  branch,
  onToggle,
}: {
  project: Project;
  open: boolean;
  /** The project's checked-out branch when it isn't the default one. */
  branch: string | null | undefined;
  onToggle: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The inline "Check command…" panel, like `confirming` swapped into the menu.
  const [checkEditing, setCheckEditing] = useState(false);
  const [checkValue, setCheckValue] = useState(project.checkCommand ?? "");
  const [fixRounds, setFixRounds] = useState(project.checkFixRounds ?? 1);
  const boxRef = useRef<HTMLDivElement>(null);
  const { deleteProject, selectProject, newThread, openInEditor, setCheckCommand, relocateProject } = useStore.getState();

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !boxRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirming(false);
        setCheckEditing(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  const act = (fn: () => Promise<void> | void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    setConfirming(false);
    setCheckEditing(false);
    void fn();
  };

  const saveCheck = async () => {
    await setCheckCommand(project.id, checkValue.trim() || null, fixRounds);
    setMenuOpen(false);
    setCheckEditing(false);
  };

  return (
    <div
      ref={boxRef}
      className={`project-row${menuOpen ? " menu-open" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
        setConfirming(false);
        setCheckEditing(false);
      }}
    >
      <button
        className="project-toggle"
        title={project.missing ? `Folder missing: ${project.path}` : project.path}
        aria-expanded={open}
        onClick={onToggle}
      >
        <IconChevron open={open} size={12} />
        <span className={`project-name${project.missing ? " missing" : ""}`}>{project.name}</span>
        {project.missing ? (
          <span className="project-missing">Folder missing</span>
        ) : (
          branch && (
            <span className="branch-chip" title={`Branch ${branch}`}>
              {branch}
            </span>
          )
        )}
      </button>
      <span className="project-actions">
        <button
          className="icon-button project-action"
          title={`New thread in ${project.name}`}
          onClick={(e) => {
            e.stopPropagation();
            void selectProject(project.id).then(() => newThread());
          }}
        >
          <IconPlus size={14} />
        </button>
        <button
          className="icon-button project-action"
          title="Project options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((m) => !m);
            setConfirming(false);
            setCheckEditing(false);
          }}
        >
          <IconMore size={14} />
        </button>
      </span>
      {menuOpen && (
        <div className="thread-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          {confirming ? (
            <>
              <p className="thread-menu-note">
                Remove “{project.name}” from CubiQ?
                <br />
                <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Project files on disk will not be deleted.
                </span>
              </p>
              <button role="menuitem" className="danger" onClick={act(() => deleteProject(project.id))}>
                Remove for Good
              </button>
              <button role="menuitem" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : checkEditing ? (
            <>
              <p className="thread-menu-note">Runs after a turn that changed files. A pass costs no tokens; each auto-fix is one more agent turn.</p>
              <input
                className="text-input"
                placeholder="bun run typecheck"
                value={checkValue}
                autoFocus
                onChange={(e) => setCheckValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveCheck();
                  } else if (e.key === "Escape") {
                    setCheckEditing(false);
                  }
                }}
              />
              <Select
                value={fixRounds}
                options={[
                  { value: 0, label: "Auto-fix: off" },
                  { value: 1, label: "Auto-fix: 1 round" },
                  { value: 2, label: "Auto-fix: 2 rounds" },
                ]}
                onChange={(v) => setFixRounds(v)}
                ariaLabel="Auto-fix"
              />
              <button role="menuitem" onClick={() => void saveCheck()}>
                Save
              </button>
              <button role="menuitem" onClick={act(() => setCheckCommand(project.id, null))}>
                Clear
              </button>
              <button role="menuitem" onClick={() => setCheckEditing(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {project.missing && (
                <button role="menuitem" onClick={act(() => relocateProject(project.id))}>
                  Locate folder…
                </button>
              )}
              <button role="menuitem" onClick={act(() => void selectProject(project.id).then(() => newThread()))}>
                New thread
              </button>
              <button role="menuitem" onClick={act(() => openInEditor({ path: project.path }))}>
                Open in editor
              </button>
              <button role="menuitem" onClick={act(() => navigator.clipboard.writeText(project.path))}>
                Copy path
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setCheckValue(project.checkCommand ?? "");
                  setFixRounds(project.checkFixRounds ?? 1);
                  setCheckEditing(true);
                }}
              >
                Check command…
              </button>
              <button role="menuitem" className="danger" onClick={() => setConfirming(true)}>
                Remove from Harness…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Ticks once a second while any thread runs, so elapsed times move. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return active ? now : Date.now();
}

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const threads = useStore((s) => s.threads);
  const running = useStore((s) => s.running);
  const permissions = useStore((s) => s.permissions);
  const plans = useStore((s) => s.plans);
  const questions = useStore((s) => s.questions);
  const finished = useStore((s) => s.finished);
  const turnStartedAt = useStore((s) => s.turnStartedAt);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const selectedThreadId = useStore((s) => s.selectedThreadId);
  const readyVersion = useStore((s) => s.appUpdate?.ready);
  const agents = useStore((s) => s.agents);
  const branches = useStore((s) => s.projectBranches);
  const grouped = useStore((s) => s.settings?.sidebarGroupByProject ?? true);
  const collapsed = useStore((s) => s.collapsedProjects);
  const kind = useStore((s) => s.threadKind);
  const { setThreadKind, addProject, selectProject, selectThread, newThread, setSearchOpen, toggleProjectCollapsed } = useStore.getState();
  const [archivedOpen, setArchivedOpen] = useState<Record<string, boolean>>({});
  const mac = api().platform === "darwin";
  const newThreadKey = mac ? "⌘N" : "Ctrl N";
  const searchKey = mac ? "⌘K" : "Ctrl K";
  const newLabel = kind === "design" ? "New design" : "New thread";

  const waiting = waitingThreads(permissions, plans, questions);
  // Only a question (no approval or plan) waits for an answer rather than an approval.
  const answering = new Set([...waitingThreads(questions)].filter((id) => !waitingThreads(permissions, plans).has(id)));
  const unread = new Set(finished.map((f) => f.threadId));
  const model = inboxModel(
    projects.map((p) => p.id),
    threads,
    { running, waiting, kind },
  );
  const now = useNow(model.running.length > 0);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
  const agentOf = (t: Thread) => agents.find((a) => a.id === t.agent);
  const statusOf = (t: Thread): ThreadStatus => (answering.has(t.id) ? "answering" : waiting.has(t.id) ? "waiting" : running[t.id] ? "running" : unread.has(t.id) ? "unread" : null);
  const open = (t: Thread) => {
    void selectProject(t.projectId);
    void selectThread(t.id);
  };
  const row = (t: Thread, live = false) => (
    <ThreadRow
      key={t.id}
      thread={t}
      agent={agentOf(t)}
      branch={t.branch}
      selected={t.id === selectedThreadId}
      status={statusOf(t)}
      time={live && turnStartedAt[t.id] ? elapsed(now - turnStartedAt[t.id]!) : shortTime(t.updatedAt, now)}
      sub={
        live ? (
          waiting.has(t.id) ? (
            <>
              <span className="need">{answering.has(t.id) ? "Needs your answer" : "Needs approval"}</span> · {agentOf(t)?.label ?? t.agent}
            </>
          ) : (
            <>
              {projectName(t.projectId)} · {agentOf(t)?.label ?? t.agent}
            </>
          )
        ) : undefined
      }
      onOpen={() => open(t)}
      onStop={live ? () => void useStore.getState().interruptThread(t.id) : undefined}
    />
  );
  const archived = (projectId: string) => {
    const list = model.archived[projectId] ?? [];
    if (!list.length) return null;
    return (
      <details
        className="thread-archived"
        open={Boolean(archivedOpen[projectId])}
        onToggle={(e) => {
          // Read it now: React clears currentTarget before the updater runs.
          const isOpen = e.currentTarget.open;
          setArchivedOpen((a) => ({ ...a, [projectId]: isOpen }));
        }}
      >
        <summary className="thread-section-label">
          <IconChevron open={Boolean(archivedOpen[projectId])} size={12} /> Archived · {list.length}
        </summary>
        {list.map((t) => row(t))}
      </details>
    );
  };
  const projectRow = (p: Project) => (
    <ProjectRow
      project={p}
      open={!collapsed[p.id]}
      branch={branches[p.id]}
      onToggle={() => {
        void selectProject(p.id);
        toggleProjectCollapsed(p.id);
      }}
    />
  );

  return (
    <aside className="sidebar" id="sidebar">
      <div className="sidebar-top drag">
        <div className="sidebar-brand">
          <span className="wordmark">CubiQ</span>
          <SidebarToggle collapsed={false} />
        </div>
        <div className="segmented compact mode-switch" role="group" aria-label="Mode">
          {(["chat", "design"] as const).map((k) => (
            <button key={k} className={kind === k ? "on" : undefined} aria-pressed={kind === k} onClick={() => void setThreadKind(k)}>
              {k === "chat" ? "Chat" : "Design"}
            </button>
          ))}
        </div>
        <ModeToggle className="mode-switch-icon" />
      </div>

      <nav className="sidebar-nav" aria-label="Sidebar">
        <button className="nav-row" title={`${newLabel} (${newThreadKey})`} onClick={() => void newThread()} disabled={!selectedProjectId}>
          <IconCompose />
          <span>{newLabel}</span>
          <kbd>{newThreadKey}</kbd>
        </button>
        <button className="nav-row" title={`Search (${searchKey})`} onClick={() => setSearchOpen(true)}>
          <IconSearch />
          <span>Search</span>
          <kbd>{searchKey}</kbd>
        </button>
        <button className="nav-row" title="Library: skills, MCP servers, agents (⌘⇧L)" onClick={() => useStore.setState({ libraryTab: "skills" })}>
          <IconLibrary />
          <span>Library</span>
        </button>
      </nav>

      <div className="sidebar-scroll">
        {model.running.length > 0 && (
          <section className="inbox-section" aria-label="Running">
            <div className="section-label">
              Running <span className="count">{model.running.length}</span>
              {model.running.length > 1 && (
                <button className="section-action" onClick={() => void useStore.getState().stopAllRunning()} title="Stop every running thread">
                  Stop all
                </button>
              )}
            </div>
            {model.running.map((t) => row(t, true))}
          </section>
        )}
        {model.pinned.length > 0 && (
          <section className="inbox-section" aria-label="Pinned">
            <div className="section-label">Pinned</div>
            {model.pinned.map((t) => row(t))}
          </section>
        )}
        {projects.length > 0 && (
          <section className="inbox-section" aria-label="Recent">
            <div className="section-label">
              Recent
              <button
                className="group-toggle"
                aria-pressed={grouped}
                title={grouped ? "Show one list" : "Group by project"}
                onClick={() => void api().updateSettings({ sidebarGroupByProject: !grouped }).then((v) => useStore.setState({ settings: v }))}
              >
                {grouped ? "By project" : "All"}
                <IconChevron open size={10} />
              </button>
            </div>
            {grouped
              ? model.groups.map(({ projectId, threads: list }) => {
                  const p = projects.find((x) => x.id === projectId)!;
                  return (
                    <div className="project" key={projectId}>
                      {projectRow(p)}
                      {!collapsed[projectId] && (
                        <>
                          {list.map((t) => row(t))}
                          {archived(projectId)}
                        </>
                      )}
                    </div>
                  );
                })
              : model.recent.map((t) => row(t))}
          </section>
        )}
        {!grouped && projects.length > 0 && (
          <section className="inbox-section" aria-label="Projects">
            <div className="section-label">Projects</div>
            {projects.map((p) => (
              <div className="project" key={p.id}>
                {projectRow(p)}
                {!collapsed[p.id] && archived(p.id)}
              </div>
            ))}
          </section>
        )}
      </div>

      {readyVersion && (
        <div className="update-ready">
          <span>
            <strong>Update ready</strong>
            <span className="version">Version {readyVersion}</span>
          </span>
          <button className="button primary" onClick={() => void api().installUpdate()}>
            Restart
          </button>
        </div>
      )}

      <div className="sidebar-foot">
        <button className="button ghost block" onClick={() => void addProject()}>
          <IconFolder /> Add project
        </button>
        <InboxBell />
        <button className="icon-button" title="Settings (⌘,)" onClick={() => useStore.getState().setSettingsOpen(true)}>
          <IconGear />
        </button>
      </div>
    </aside>
  );
}
