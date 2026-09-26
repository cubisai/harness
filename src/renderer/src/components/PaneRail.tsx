import { IconArrowLeft, IconArrowRight, IconCompose, IconFolder, IconGear, IconLibrary, IconRefresh } from "../icons";
import { api } from "../api";
import { InboxBell } from "./MessageCenter";
import { useStore } from "../store";

/** Collapse or restore the sidebar (⌘\ / Ctrl+\). Points the way the sidebar will move. */
export function SidebarToggle({ collapsed }: { collapsed: boolean }) {
  return (
    <button
      className="icon-button"
      aria-expanded={!collapsed}
      aria-controls="sidebar"
      title={collapsed ? "Show sidebar (⌘\\)" : "Hide sidebar (⌘\\)"}
      onClick={() => toggleSidebar()}
    >
      {collapsed ? <IconArrowRight /> : <IconArrowLeft />}
    </button>
  );
}

export function toggleSidebar(): void {
  const s = useStore.getState();
  s.setPaneLayout({ sidebarCollapsed: !s.paneLayout.sidebarCollapsed }, true);
}

/** The collapsed sidebar: a narrow rail with every sidebar-footer control, each titled. */
export function PaneRail() {
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const newThread = useStore((s) => s.newThread);
  const addProject = useStore((s) => s.addProject);
  const readyVersion = useStore((s) => s.appUpdate?.ready);

  return (
    <nav className="pane-rail" id="sidebar" aria-label="Sidebar">
      <div className="rail-top drag">
        <SidebarToggle collapsed />
      </div>
      <button className="icon-button" title="New thread (⌘N)" onClick={() => void newThread()} disabled={!selectedProjectId}>
        <IconCompose />
      </button>
      <div className="rail-foot">
        {readyVersion && (
          <button className="icon-button active" title={`Update ready: restart to install version ${readyVersion}`} onClick={() => void api().installUpdate()}>
            <IconRefresh />
          </button>
        )}
        <button className="icon-button" title="Add Project…" onClick={() => void addProject()}>
          <IconFolder />
        </button>
        <InboxBell />
        <button className="icon-button" title="Library: skills, MCP servers, agents (⌘⇧L)" onClick={() => useStore.setState({ libraryTab: "skills" })}>
          <IconLibrary />
        </button>
        <button className="icon-button" title="Settings (⌘,)" onClick={() => useStore.getState().setSettingsOpen(true)}>
          <IconGear />
        </button>
      </div>
    </nav>
  );
}
