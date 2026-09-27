import { useState } from "react";
import type { Thread } from "../../../shared/types";
import { IconChevron, IconCompose, IconFolder, IconGear, IconLibrary } from "../icons";
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
        <span className="wordmark">UnSkilled</span>
        <SidebarToggle collapsed={false} />
        <button className="icon-button" title="New thread (⌘N)" onClick={() => void newThread()} disabled={!selectedProjectId}>
          <IconCompose />
        </button>
      </div>

      <div className="sidebar-scroll">
        {projects.length > 0 && <div className="section-label">Projects</div>}
        {projects.map((p) => {
          const list = threads[p.id] ?? [];
          const open = !collapsed[p.id];
          return (
            <div className="project" key={p.id}>
              <button
                className="project-row"
                title={p.path}
                onClick={() => {
                  void selectProject(p.id);
                  setCollapsed((c) => ({ ...c, [p.id]: selectedProjectId === p.id ? open : false }));
                }}
              >
                <IconChevron open={open} />
                <span>{p.name}</span>
                <span className="count">{list.filter((t) => !t.archived).length || ""}</span>
              </button>
              {open &&
                sectionThreads(list, { running, now }).map((section) => (
                  <div className="thread-section" key={section.name}>
                    <div className="thread-section-label">{section.name}</div>
                    {section.threads.map((t) => row(p.id, t))}
                  </div>
                ))}
              {open && archivedThreads(list).length > 0 && (
                <details className="thread-archived">
                  <summary className="thread-section-label">Archived · {archivedThreads(list).length}</summary>
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
