import { useEffect, useRef, useState } from "react";
import { Check, PenTool } from "lucide-react";
import type { WorkspaceMode } from "../../../shared/types";
import { IconCompose, IconFolder, IconGear, IconLibrary, IconRefresh, IconSidebarClose, IconSidebarOpen } from "../icons";
import { api } from "../api";
import { InboxBell } from "./MessageCenter";
import { useStore } from "../store";

const WORKSPACE_MODES: { id: WorkspaceMode; label: string; desc: string }[] = [
  { id: "chat", label: "Chat", desc: "Code and conversation" },
  { id: "design", label: "Design", desc: "Pages and components on a canvas" },
  { id: "creator", label: "Creator", desc: "Add skills and MCP connectors" },
];

/** Workspace mode menu where the three-part switch doesn't fit (the rail, a narrow sidebar). */
export function ModeToggle({ className = "" }: { className?: string }) {
  const kind = useStore((s) => s.threadKind);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = WORKSPACE_MODES.find((m) => m.id === kind) ?? WORKSPACE_MODES[0]!;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  const openMenu = () => {
    const idx = WORKSPACE_MODES.findIndex((m) => m.id === kind);
    setActive(idx >= 0 ? idx : 0);
    setOpen(true);
  };

  const closeMenu = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  return (
    <div
      className={`model-picker${className ? ` ${className}` : ""}`}
      ref={box}
      onKeyDown={(e) => {
        if (!open) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openMenu();
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeMenu(true);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive((i) => (i + 1) % WORKSPACE_MODES.length);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive((i) => (i - 1 + WORKSPACE_MODES.length) % WORKSPACE_MODES.length);
        } else if (e.key === "Home") {
          e.preventDefault();
          setActive(0);
        } else if (e.key === "End") {
          e.preventDefault();
          setActive(WORKSPACE_MODES.length - 1);
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`icon-button${kind !== "chat" ? " active" : ""}`}
        title={`Workspace mode: ${current.label}`}
        aria-label={`Workspace mode: ${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? closeMenu(true) : openMenu())}
      >
        <PenTool size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {open && (
        <div className="model-menu mode-menu" role="listbox" aria-label="Workspace mode">
          <div className="model-group">Mode</div>
          {WORKSPACE_MODES.map((m, i) => (
            <button
              key={m.id}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="option"
              aria-selected={m.id === kind}
              className={`model-item two-line${m.id === kind ? " current" : ""}${i === active ? " active" : ""}`}
              onClick={() => {
                closeMenu(true);
                if (m.id !== kind) void useStore.getState().setThreadKind(m.id);
              }}
            >
              <Check size={13} className="check" aria-hidden />
              <span className="label">
                {m.label}
                <span className="desc">{m.desc}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
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
