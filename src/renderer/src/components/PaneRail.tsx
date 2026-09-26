import { IconArrowLeft, IconArrowRight, IconCompose, IconGear, IconLibrary } from "../icons";
import { useStore } from "../store";

/** Collapse or restore the sidebar. Points the way the sidebar will move. */
export function SidebarToggle({ collapsed }: { collapsed: boolean }) {
  return (
    <button
      className="icon-button"
      aria-expanded={!collapsed}
      aria-controls="sidebar"
      title={collapsed ? "Show sidebar" : "Hide sidebar"}
      onClick={() => useStore.getState().setPaneLayout({ sidebarCollapsed: !collapsed }, true)}
    >
      {collapsed ? <IconArrowRight /> : <IconArrowLeft />}
    </button>
  );
}

/** The collapsed sidebar: a narrow rail of the actions that matter without the project list. */
export function PaneRail() {
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const newThread = useStore((s) => s.newThread);

  return (
    <nav className="pane-rail" id="sidebar" aria-label="Sidebar">
      <div className="rail-top drag">
        <SidebarToggle collapsed />
      </div>
      <button className="icon-button" title="New thread (⌘N)" onClick={() => void newThread()} disabled={!selectedProjectId}>
        <IconCompose />
      </button>
      <button className="icon-button" title="Library: skills, MCP servers, agents (⌘⇧L)" onClick={() => useStore.setState({ libraryTab: "skills" })}>
        <IconLibrary />
      </button>
      <button className="icon-button" title="Settings (⌘,)" onClick={() => useStore.getState().setSettingsOpen(true)}>
        <IconGear />
      </button>
    </nav>
  );
}
