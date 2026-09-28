import { useEffect, useRef, useState } from "react";
import type { Project, Thread } from "../../../shared/types";
import { IconChevron, IconCompose, IconFolder, IconGear, IconLibrary, IconMore, IconPlus } from "../icons";
import { api } from "../api";
import { archivedThreads, sectionThreads } from "../sections";
import { ThreadRow } from "./ThreadRow";
import { useStore } from "../store";
import { InboxBell } from "./MessageCenter";
import { SidebarToggle } from "./PaneRail";

function ProjectRow({
  project,
  open,
  count,
  onToggle,
}: {
  project: Project;
  open: boolean;
  count: number;
  onToggle: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const { deleteProject, selectProject, newThread, openInEditor } = useStore.getState();

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !boxRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirming(false);
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
    void fn();
  };

  return (
    <div
      ref={boxRef}
      className={`project-row${menuOpen ? " menu-open" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
        setConfirming(false);
      }}
    >
      <button
        className="project-toggle"
        title={project.path}
        aria-expanded={open}
        onClick={onToggle}
      >
        <IconChevron open={open} />
        <span className="project-name">{project.name}</span>
        <span className="count">{count || ""}</span>
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
          ) : (
            <>
              <button role="menuitem" onClick={act(() => selectProject(project.id).then(() => newThread()))}>
                New thread
              </button>
              <button role="menuitem" onClick={act(() => openInEditor({ path: project.path }))}>
                Open in editor
              </button>
              <button role="menuitem" onClick={act(() => navigator.clipboard.writeText(project.path))}>
                Copy path
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

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const threads = useStore((s) => s.threads);
  const running = useStore((s) => s.running);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const selectedThreadId = useStore((s) => s.selectedThreadId);
  const readyVersion = useStore((s) => s.appUpdate?.ready);
  const agents = useStore((s) => s.agents);
  const branches = useStore((s) => s.projectBranches);
  const { addProject, selectProject, selectThread, newThread } = useStore.getState();
  // Sections are re-read on every render (any thread update re-renders), so Settled stays current enough.
  const now = Date.now();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [archivedOpen, setArchivedOpen] = useState<Record<string, boolean>>({});
  const newThreadKey = api().platform === "darwin" ? "⌘N" : "Ctrl N";
  const row = (projectId: string, t: Thread) => (
    <ThreadRow
      key={t.id}
      thread={t}
      agent={agents.find((a) => a.id === t.agent)}
      branch={t.branch ?? branches[projectId]}
      selected={t.id === selectedThreadId}
      running={Boolean(running[t.id])}
      onOpen={() => {
        void selectProject(projectId);
        void selectThread(t.id);
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
      </div>

      <button className="new-thread-button" title={`New thread (${newThreadKey})`} onClick={() => void newThread()} disabled={!selectedProjectId}>
        <IconCompose />
        <span>New thread</span>
        <kbd>{newThreadKey}</kbd>
      </button>

      <div className="sidebar-scroll">
        {projects.length > 0 && <div className="section-label">Projects</div>}
        {projects.map((p) => {
          const list = threads[p.id] ?? [];
          const open = !collapsed[p.id];
          return (
            <div className="project" key={p.id}>
              <ProjectRow
                project={p}
                open={open}
                count={list.filter((t) => !t.archived).length}
                onToggle={() => {
                  void selectProject(p.id);
                  setCollapsed((c) => ({ ...c, [p.id]: selectedProjectId === p.id ? open : false }));
                }}
              />
              {open &&
                sectionThreads(list, { running, now }).map((section) => (
                  <div className="thread-section" key={section.name}>
                    <div className="thread-section-label">{section.name}</div>
                    {section.threads.map((t) => row(p.id, t))}
                  </div>
                ))}
              {open && archivedThreads(list).length > 0 && (
                <details className="thread-archived" onToggle={(e) => setArchivedOpen((a) => ({ ...a, [p.id]: e.currentTarget.open }))}>
                  <summary className="thread-section-label">
                    <IconChevron open={Boolean(archivedOpen[p.id])} size={12} /> Archived · {archivedThreads(list).length}
                  </summary>
                  {archivedThreads(list).map((t) => row(p.id, t))}
                </details>
              )}
            </div>
          );
        })}
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
          <IconFolder /> Add Project…
        </button>
        <InboxBell />
        <button className="icon-button" title="Library: skills, MCP servers, agents (⌘⇧L)" onClick={() => useStore.setState({ libraryTab: "skills" })}>
          <IconLibrary />
        </button>
        <button className="icon-button" title="Settings (⌘,)" onClick={() => useStore.getState().setSettingsOpen(true)}>
          <IconGear />
        </button>
      </div>
    </aside>
  );
}
