import { PenTool } from "lucide-react";
import { IconCompose, IconFolder, IconGear, IconLibrary, IconRefresh, IconSidebarClose, IconSidebarOpen } from "../icons";
import { api } from "../api";
import { InboxBell } from "./MessageCenter";
import { useStore } from "../store";

/** Chat or Design as one icon button, where the two-part switch doesn't fit (the rail, a narrow sidebar). */
export function ModeToggle({ className = "" }: { className?: string }) {
  const kind = useStore((s) => s.threadKind);
  return (
    <button
      className={`icon-button${kind === "design" ? " active" : ""}${className ? ` ${className}` : ""}`}
      title={kind === "design" ? "Design mode: switch to Chat" : "Chat mode: switch to Design"}
      aria-pressed={kind === "design"}
      onClick={() => void useStore.getState().setThreadKind(kind === "design" ? "chat" : "design")}
    >
      <PenTool size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

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
      {collapsed ? <IconSidebarOpen /> : <IconSidebarClose />}
    </button>
  );
}

export function toggleSidebar(): void {
  const s = useStore.getState();
  if (s.studioFold !== null) useStore.setState({ studioFold: !s.studioFold });
  else s.setPaneLayout({ sidebarCollapsed: !s.paneLayout.sidebarCollapsed }, true);
}

/** With the sidebar collapsed: its toggle and New thread, at the start of the title bar. */
export function CollapsedHeaderControls() {
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const newThread = useStore((s) => s.newThread);
  return (
    <div className="header-rail-controls">
      <SidebarToggle collapsed />
      <button className="icon-button" title="New thread (⌘N)" onClick={() => void newThread()} disabled={!selectedProjectId}>
        <IconCompose />
      </button>
    </div>
  );
}

/** The collapsed sidebar: a narrow rail with every sidebar-footer control, each titled. */
export function PaneRail() {
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const newThread = useStore((s) => s.newThread);
  const addProject = useStore((s) => s.addProject);
  const readyVersion = useStore((s) => s.appUpdate?.ready);

  return (
    <nav className="pane-rail" id="sidebar" aria-label="Sidebar">
      {/* The title bar's share of the rail: the toggle and New thread sit in the header. */}
      <div className="rail-top drag" />
      <ModeToggle />
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
