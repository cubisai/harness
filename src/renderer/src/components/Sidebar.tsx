import { useState } from "react";
import type { Thread } from "../../../shared/types";
import { IconChevron, IconCompose, IconFolder, IconGear, IconLibrary, IconPlus } from "../icons";
import { api } from "../api";
import { archivedThreads, sectionThreads } from "../sections";
import { ThreadRow } from "./ThreadRow";
import { useStore } from "../store";
import { InboxBell } from "./MessageCenter";
import { SidebarToggle } from "./PaneRail";

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
      branch={branches[projectId]}
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
          <span className="wordmark">UnSkilled</span>
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
              <div className="project-row">
                <button
                  className="project-toggle"
                  title={p.path}
                  aria-expanded={open}
                  onClick={() => {
                    void selectProject(p.id);
                    setCollapsed((c) => ({ ...c, [p.id]: selectedProjectId === p.id ? open : false }));
                  }}
                >
                  <IconChevron open={open} />
                  <span className="project-name">{p.name}</span>
                  <span className="count">{list.filter((t) => !t.archived).length || ""}</span>
                </button>
                <span className="project-actions">
                  <button
                    className="icon-button project-action"
                    title={`New thread in ${p.name}`}
                    onClick={() => void selectProject(p.id).then(() => newThread())}
                  >
                    <IconPlus size={14} />
                  </button>
                </span>
              </div>
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
