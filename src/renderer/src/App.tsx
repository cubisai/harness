import { Suspense, lazy, useEffect } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { SearchDialog } from "./components/SearchDialog";
import { Library } from "./components/Library";
import { Composer } from "./components/Composer";
import { RequestDock } from "./components/RequestDock";
import { TodoDock } from "./components/TodoDock";
import { ThreadMeters } from "./components/Meters";
import { DraftMode, DraftModel, ThreadMode, ThreadModel } from "./components/ThreadControls";
import { DraftDesignSystem, ThreadDesignSystem } from "./components/DesignSystemMenu";
import { ThreadTier } from "./components/TierMenu";
import { Inspector } from "./components/Inspector";
import { SettingsSheet } from "./components/SettingsSheet";
import { Splash } from "./components/Splash";
import { MessageCenter } from "./components/MessageCenter";
import { Sidebar } from "./components/Sidebar";
import { CollapsedHeaderControls, PaneRail, toggleSidebar } from "./components/PaneRail";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { Splitter } from "./components/Splitter";
import { SwitchDialogHost } from "./components/SwitchDialog";
import { AboutSheet } from "./components/AboutSheet";
import { ContextSheet } from "./components/ContextSheet";
import { McpSheet } from "./components/McpSheet";
import { ThreadView } from "./components/ThreadView";
import { IconArrowLeft, IconDiff, IconFolder, IconGlobe, IconSparkle, IconTerminal } from "./icons";
import { usePaneLayout } from "./hooks/usePaneLayout";
import { BOUNDS, DEFAULT_LAYOUT, DESIGN_FLOOR, isWideInspector } from "./layout";
import { ESCAPE_OWNERS, escapeStopsTurn, type EscapeTarget } from "./escape";
import { inboxModel, nthVisibleThread, threadKind, waitingThreads } from "./sections";
import { useSelectedThread, useStore } from "./store";

// Its own chunk: Chat never loads the design canvas.
const DesignCanvas = lazy(() => import("./design/DesignCanvas"));


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
  const initError = useStore((s) => s.initError);

  useEffect(() => {
    void init();
  }, [init]);

  // ⌘K: search (> in it, or ⌘⇧P, for the command palette). ⌘\: sidebar. ⌘N / Ctrl+N: new thread. ⌘⇧D: changes. Esc: stop the running turn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = useStore.getState();
        if (s.searchOpen || s.paletteOpen) {
          s.setSearchOpen(false);
          s.setPaletteOpen(false);
        } else s.setSearchOpen(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        const s = useStore.getState();
        s.setPaletteOpen(!s.paletteOpen, ">");
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
        if (document.querySelector(".palette, .search-dialog, .sheet, .library") || document.activeElement?.tagName === "WEBVIEW") return;
        const s = useStore.getState();
        const model = inboxModel(
          s.projects.map((p) => p.id),
          s.threads,
          { running: s.running, waiting: waitingThreads(s.permissions, s.plans, s.questions), kind: s.threadKind },
        );
        const target = nthVisibleThread(model, Number(e.key), { groupByProject: s.settings?.sidebarGroupByProject ?? true, collapsed: s.collapsedProjects });
        if (target) {
          e.preventDefault();
          void s.selectProject(target.projectId);
          void s.selectThread(target.id);
        }
      } else if (escapeStopsTurn({ key: e.key, defaultPrevented: e.defaultPrevented, target: e.target as EscapeTarget | null }, running, document.querySelector(ESCAPE_OWNERS) !== null)) {
        void interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newThread, showInspector, interrupt, running]);

  // The browser works without a project; Changes and Files need one.
  const inspectorVisible = inspectorOpen && (project || inspectorTab === "browser");
  const layout = useStore((s) => s.paneLayout);
  const designThread = Boolean(thread && threadKind(thread) === "design");
  const pane = usePaneLayout(Boolean(inspectorVisible), designThread ? DESIGN_FLOOR : undefined);
  const setPaneLayout = useStore((s) => s.setPaneLayout);
  // A width that leaves the chat under its normal minimum was dragged there on purpose: keep it wide.
  const inspectorPatch = (v: number, c: boolean) => {
    const inspector = v || layout.inspector;
    return { inspector, inspectorCollapsed: c, inspectorWide: isWideInspector(pane.width, pane.sidebar, inspector) };
  };
  const wide = layout.browserWide && inspectorVisible && inspectorTab === "browser" && pane.inspector !== null;
  // A design thread puts its canvas between the chat and the side panel; browser-wide still wins.
  const design = designThread && !wide;
  const designMode = useStore((s) => s.threadKind) === "design";

  return (
    <div className={`app${inspectorVisible && pane.inspector !== null ? " with-inspector" : ""}${wide ? " browser-wide" : ""}${layout.sidebarCollapsed ? " sidebar-collapsed" : ""}${design ? " design-thread" : ""}`}>
      {layout.sidebarCollapsed ? <PaneRail /> : <Sidebar />}
      <main className="main">
        {wide ? (
          // The browser holds the main area; the conversation is just a rail.
          // The Inspector stays mounted either way, so the page survives.
          <ConversationRail />
        ) : (
          <>
            <header className="main-header drag">
              {layout.sidebarCollapsed && <CollapsedHeaderControls />}
              <div className="main-title">
                {thread ? thread.title : project ? project.name : "CubiQ"}
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
              initError ? (
                <div className="empty" role="alert">
                  <div>
                    <h1>CubiQ couldn't start</h1>
                    <p>{initError}</p>
                    <button className="button primary" onClick={() => void init()}>
                      Try again
                    </button>
                  </div>
                </div>
              ) : (
                <div className="empty">
                  <div>
                    <h1>Welcome to CubiQ</h1>
                    <p>Open a project folder to start. Claude works inside it, with the skilled workflow built in.</p>
                    <button className="button primary" onClick={() => void addProject()}>
                      <IconFolder /> Open Project…
                    </button>
                  </div>
                </div>
              )
            ) : !thread ? (
              <>
                <div className="start-thread">
                  {designMode ? (
                    <>
                      <h1>What should we design in {project.name}?</h1>
                      <p>Describe a page, screen or component. The design opens on a canvas beside this chat.</p>
                    </>
                  ) : (
                    <>
                      <h1>What should we build in {project.name}?</h1>
                      <p>Describe a change, ask about the code, or type $ for a skill or / for a command.</p>
                    </>
                  )}
                </div>
                <Composer
                  threadId={null}
                  mode={
                    designMode ? (
                      <>
                        <DraftMode />
                        <DraftDesignSystem />
                      </>
                    ) : (
                      <DraftMode />
                    )
                  }
                  model={<DraftModel />}
                />
              </>
            ) : (
              <>
                <ThreadView threadId={thread.id} />
                <TodoDock threadId={thread.id} />
                <RequestDock threadId={thread.id} />
                <Composer
                  threadId={thread.id}
                  mode={
                    designThread ? (
                      <>
                        <ThreadMode thread={thread} running={running} />
                        <ThreadDesignSystem thread={thread} running={running} />
                        <ThreadTier thread={thread} running={running} />
                      </>
                    ) : (
                      <ThreadMode thread={thread} running={running} />
                    )
                  }
                  model={<ThreadModel thread={thread} running={running} />}
                  meters={<ThreadMeters agent={thread.agent} threadId={thread.id} />}
                />
              </>
            )}
          </>
        )}
        {/* Outside the wide branch: the shells stay mounted (hidden) while the browser has the main area. */}
        <TerminalDrawer />
      </main>
      {design && thread && (
        <Suspense fallback={<section className="design-canvas" aria-label="Design canvas" />}>
          <DesignCanvas threadId={thread.id} />
        </Suspense>
      )}
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
          // The drawn width (a narrowed panel drags from where it is), capped relative to the window.
          value={pane.inspector ?? layout.inspector}
          min={BOUNDS.inspector.min}
          max={pane.inspectorMax}
          defaultValue={DEFAULT_LAYOUT.inspector}
          collapsed={layout.inspectorCollapsed}
          invert
          className="splitter-inspector"
          onChange={(v, c) => setPaneLayout(inspectorPatch(v, c), false)}
          onCommit={(v, c) => setPaneLayout(inspectorPatch(v, c), true)}
        />
      )}
      {inspectorVisible && pane.inspector !== null && <Inspector projectId={project?.id ?? null} />}
      <SettingsSheet />
      <MessageCenter />
      <Notice />
      <Library />
      <CommandPalette />
      <SearchHost />
      <SwitchDialogHost />
      <AboutSheet />
      <ContextSheet />
      <McpSheet />
      <Splash />
    </div>
  );
}

/** ⌘K: search threads, messages and the project's files; ">" hands off to the command palette. */
function SearchHost() {
  const open = useStore((s) => s.searchOpen);
  const projectId = useStore((s) => s.selectedProjectId);
  const projects = useStore((s) => s.projects);
  const agents = useStore((s) => s.agents);
  const running = useStore((s) => s.running);
  if (!open) return null;
  const s = useStore.getState();
  return (
    <SearchDialog
      projectId={projectId}
      projects={projects}
      agents={agents.map((a) => ({ id: a.id, label: a.label }))}
      runningThreadIds={Object.keys(running).filter((id) => running[id])}
      onOpenThread={(threadId) => {
        const thread = Object.values(useStore.getState().threads).flat().find((t) => t.id === threadId);
        if (thread) void s.selectProject(thread.projectId).then(() => s.selectThread(threadId));
      }}
      onOpenFile={(path) => (useStore.getState().selectedThreadId ? s.openArtifact(path) : void s.openInEditor({ path }))}
      onActions={(query) => s.setPaletteOpen(true, query)}
      onClose={() => s.setSearchOpen(false)}
    />
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

