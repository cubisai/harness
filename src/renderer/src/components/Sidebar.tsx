import { useState } from "react";
import { IconChevron, IconCompose, IconFolder, IconGear, IconLibrary, IconPin } from "../icons";
import { api } from "../api";
import { sectionThreads } from "../sections";
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
  const pinned = useStore((s) => s.pinned);
  const branches = useStore((s) => s.projectBranches);
  const { addProject, selectProject, selectThread, newThread, togglePin } = useStore.getState();
  // Sections are re-read on every render (any thread update re-renders), so Settled stays current enough.
  const now = Date.now();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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
                <span className="count">{list.length || ""}</span>
              </button>
              {open &&
                sectionThreads(list, { running, pinned, now }).map((section) => (
                  <div className="thread-section" key={section.name}>
                    <div className="thread-section-label">{section.name === "Pinned" ? "Pinned · this session" : section.name}</div>
                    {section.threads.map((t) => {
                      const agent = agents.find((a) => a.id === t.agent)?.label ?? t.agent;
                      const branch = branches[p.id];
                      return (
                        <div key={t.id} className={`thread-row${t.id === selectedThreadId ? " selected" : ""}`}>
                          <button
                            className="thread-open"
                            onClick={() => {
                              void selectProject(p.id);
                              void selectThread(t.id);
                            }}
                          >
                            <span className="thread-text">
                              <span className="title">{t.title}</span>
                              <span className="thread-meta">
                                <span>{agent}</span>
                                {branch && (
                                  <span className="branch-chip" title={`Branch ${branch}`}>
                                    {branch}
                                  </span>
                                )}
                              </span>
                            </span>
                            {running[t.id] && <span className="spinner" />}
                          </button>
                          <button
                            className="icon-button thread-pin"
                            aria-pressed={Boolean(pinned[t.id])}
                            title={pinned[t.id] ? "Unpin" : "Pin (until the app restarts)"}
                            onClick={() => togglePin(t.id)}
                          >
                            <IconPin />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
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
