import { useState } from "react";
import { IconChevron, IconCompose, IconFolder, IconGear, IconLibrary } from "../icons";
import { api } from "../api";
import { useStore } from "../store";

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const threads = useStore((s) => s.threads);
  const running = useStore((s) => s.running);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const selectedThreadId = useStore((s) => s.selectedThreadId);
  const readyVersion = useStore((s) => s.appUpdate?.ready);
  const { addProject, selectProject, selectThread, newThread } = useStore.getState();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <span className="wordmark">UnSkilled</span>
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
                list.map((t) => (
                  <button
                    key={t.id}
                    className={`thread-row${t.id === selectedThreadId ? " selected" : ""}`}
                    onClick={() => {
                      void selectProject(p.id);
                      void selectThread(t.id);
                    }}
                  >
                    <span className="title">{t.title}</span>
                    {running[t.id] && <span className="spinner" />}
                  </button>
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
