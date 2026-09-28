import { useEffect } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Library } from "./components/Library";
import { Composer } from "./components/Composer";
import { ThreadMeters } from "./components/Meters";
import { DraftControls, ThreadControls } from "./components/ThreadControls";
import { Inspector } from "./components/Inspector";
import { SettingsSheet } from "./components/SettingsSheet";
import { MessageCenter } from "./components/MessageCenter";
import { Sidebar } from "./components/Sidebar";
import { PaneRail, toggleSidebar } from "./components/PaneRail";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { Splitter } from "./components/Splitter";
import { SwitchDialogHost } from "./components/SwitchDialog";
import { ThreadView } from "./components/ThreadView";
import { IconArrowLeft, IconDiff, IconFolder, IconGlobe, IconSparkle, IconTerminal } from "./icons";
import { usePaneLayout } from "./hooks/usePaneLayout";
import { BOUNDS, DEFAULT_LAYOUT } from "./layout";
import { nthVisibleThread } from "./sections";
import { useSelectedThread, useStore } from "./store";


export function App() {
  const projects = useStore((s) => s.projects);
  const selectedProjectId = useStore((s) => s.selectedProjectId);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const inspectorTab = useStore((s) => s.inspectorTab);
  const agents = useStore((s) => s.agents);
  const thread = useSelectedThread();
  const running = useStore((s) => (thread ? Boolean(s.running[thread.id]) : false));
  const { init, newThread, showInspector, updateThread, interrupt, addProject } = useStore.getState();
  const project = projects.find((p) => p.id === selectedProjectId) ?? null;

  useEffect(() => {
    void init();
  }, [init]);

  // ⌘K: command palette. ⌘\: sidebar. ⌘N / Ctrl+N: new thread. ⌘⇧D: changes. Esc: stop the running turn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = useStore.getState();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        const s = useStore.getState();
        useStore.setState({ libraryTab: s.libraryTab ? null : "skills" });
      } else if (mod && e.altKey && e.key === ",") {
        // Ctrl/Cmd+Alt+, steps reasoning effort down, wrapping to Default.
        e.preventDefault();
        useStore.getState().cycleEffort(-1);
      } else if (mod && e.altKey && e.key === ".") {
        e.preventDefault();
        useStore.getState().cycleEffort(1);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        useStore.getState().setSettingsOpen(true);
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newThread();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        showInspector("changes");
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        useStore.getState().toggleTerminal();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        showInspector("browser");
      } else if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        // ⌘1–9: the nth thread in the sidebar's order. Not over a modal, and not
        // while the browser pane has focus (its page keeps its own shortcuts).
        if (document.querySelector(".palette, .sheet, .library") || document.activeElement?.tagName === "WEBVIEW") return;
        const s = useStore.getState();
        const list = s.selectedProjectId ? (s.threads[s.selectedProjectId] ?? []) : [];
        const target = nthVisibleThread(list, Number(e.key), { running: s.running, now: Date.now() });
        if (target) {
          e.preventDefault();
          void s.selectThread(target.id);
        }
      } else if (e.key === "Escape" && running &&!document.querySelector(".skill-menu, .palette, .sheet, .library")) {
        void interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newThread, showInspector, interrupt, running]);

  // The browser works without a project; Changes and Files need one.
  const inspectorVisible = inspectorOpen && (project || inspectorTab === "browser");
  const layout = useStore((s) => s.paneLayout);
  const pane = usePaneLayout(Boolean(inspectorVisible));
  const setPaneLayout = useStore((s) => s.setPaneLayout);
  const wide = layout.browserWide && inspectorVisible && inspectorTab === "browser" && pane.inspector !== null;

  return (
    <div className={`app${inspectorVisible && pane.inspector !== null ? " with-inspector" : ""}${wide ? " browser-wide" : ""}`}>
      {layout.sidebarCollapsed ? <PaneRail /> : <Sidebar />}
      <main className="main">
        {wide ? (
          // The browser holds the main area; the conversation is just a rail.
          // The Inspector stays mounted either way, so the page survives.
          <ConversationRail />
        ) : (
          <>
            <header className="main-header drag">
              <div className="main-title">
                {thread ? thread.title : project ? project.name : "UnSkilled"}
                {thread && project && <span className="sub">{project.name}</span>}
              </div>
              {project && (
                <>
                  <button
                    className={`icon-button${inspectorOpen && inspectorTab === "changes" ? " active" : ""}`}
                    title="Changes (⌘⇧D)"
                    aria-expanded={inspectorOpen && inspectorTab === "changes"}
                    aria-controls="inspector"
                    onClick={() => showInspector("changes")}
                  >
                    <IconDiff />
                  </button>
                  <button
                    className={`icon-button${inspectorOpen && inspectorTab === "browser" ? " active" : ""}`}
                    title="Browser (⌘⇧B)"
                    aria-expanded={inspectorOpen && inspectorTab === "browser"}
                    aria-controls="inspector"
                    onClick={() => showInspector("browser")}
                  >
                    <IconGlobe />
                  </button>
                  <button
                    className={`icon-button${layout.terminalOpen ? " active" : ""}`}
                    title="Terminal (⌃`)"
                    aria-expanded={layout.terminalOpen}
                    aria-controls="terminal-drawer"
                    onClick={() => useStore.getState().toggleTerminal()}
                  >
                    <IconTerminal />
                  </button>
                </>
              )}
            </header>

            {!project ? (
              <div className="empty">
                <div>
                  <h1>Welcome to UnSkilled</h1>
                  <p>Open a project folder to start. Claude works inside it, with the skilled workflow built in.</p>
                  <button className="button primary" onClick={() => void addProject()}>
                    <IconFolder /> Open Project…
                  </button>
                </div>
              </div>
            ) : !thread ? (
              <>
                <div className="start-thread">
                  <h1>What should we build in {project.name}?</h1>
                  <p>Describe a change, ask about the code, or type / for a skill.</p>
                </div>
                <Composer threadId={null} controls={<DraftControls />} />
              </>
            ) : (
              <>
                <ThreadView threadId={thread.id} />
                <Composer
                  threadId={thread.id}
                  controls={<ThreadControls thread={thread} running={running} />}
                  meters={<ThreadMeters agent={thread.agent} threadId={thread.id} />}
                />
              </>
            )}
          </>
        )}
        {/* Outside the wide branch: the shells stay mounted (hidden) while the browser has the main area. */}
        <TerminalDrawer />
      </main>
      <Splitter
        orientation="vertical"
        controls="sidebar"
        label="Resize sidebar"
        value={layout.sidebar}
        min={BOUNDS.sidebar.min}
        max={BOUNDS.sidebar.max}
        defaultValue={DEFAULT_LAYOUT.sidebar}
        collapsed={layout.sidebarCollapsed}
        className="splitter-sidebar"
        onChange={(v, c) => setPaneLayout({ sidebar: v || layout.sidebar, sidebarCollapsed: c }, false)}
        onCommit={(v, c) => setPaneLayout({ sidebar: v || layout.sidebar, sidebarCollapsed: c }, true)}
      />
      {!wide && inspectorVisible && (
        <Splitter
          orientation="vertical"
          controls="inspector"
          label="Resize side panel"
          value={layout.inspector}
          min={BOUNDS.inspector.min}
          max={BOUNDS.inspector.max}
          defaultValue={DEFAULT_LAYOUT.inspector}
          collapsed={layout.inspectorCollapsed}
          invert
          className="splitter-inspector"
          onChange={(v, c) => setPaneLayout({ inspector: v || layout.inspector, inspectorCollapsed: c }, false)}
          onCommit={(v, c) => setPaneLayout({ inspector: v || layout.inspector, inspectorCollapsed: c }, true)}
        />
      )}
      {inspectorVisible && pane.inspector !== null && <Inspector projectId={project?.id ?? null} />}
      <SettingsSheet />
      <MessageCenter />
      <Notice />
      <Library />
      <CommandPalette />
      <SwitchDialogHost />
    </div>
  );
}

/** The conversation while the browser holds the main area: the way back, and a heartbeat. */
function ConversationRail() {
  const thread = useSelectedThread();
  const running = useStore((s) => (thread ? Boolean(s.running[thread.id]) : false));
  return (
    <div className="conversation-rail">
      <button className="icon-button" title="Back to the conversation" aria-controls="inspector" onClick={() => useStore.getState().toggleBrowserWide()}>
        <IconArrowLeft />
      </button>
      {running && <span className="spinner" />}
    </div>
  );
}




function Notice() {
  const text = useStore((s) => s.notice);
  return text ? (
    <div className="toast" role="status">
      {text}
    </div>
  ) : null;
}

