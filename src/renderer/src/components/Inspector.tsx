import { useState } from "react";
import { IconRefresh } from "../icons";
import { useStore } from "../store";
import { BrowserPanel } from "./BrowserPanel";
import { OpenIn } from "./OpenIn";
import { DiffPanel } from "./DiffPanel";
import { TerminalPanel } from "./TerminalPanel";

/** The right-hand panel: Changes and Browser. The browser stays mounted once opened, so its page survives tab switches. */
export function Inspector({ projectId }: { projectId: string | null }) {
  const tab = useStore((s) => s.inspectorTab);
  const browserMounted = useStore((s) => s.browserMounted);
  const showInspector = useStore((s) => s.showInspector);
  const terminals = useStore((s) => s.terminals);
  const projects = useStore((s) => s.projects);
  const currentTerminal = projectId ?? "home";
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <aside className="inspector">
      <div className="inspector-head drag">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "on" : ""} onClick={() => tab !== "changes" && showInspector("changes")}>
            Changes
          </button>
          <button role="tab" aria-selected={tab === "browser"} className={tab === "browser" ? "on" : ""} onClick={() => tab !== "browser" && showInspector("browser")}>
            Browser
          </button>
          <button role="tab" aria-selected={tab === "terminal"} className={tab === "terminal" ? "on" : ""} onClick={() => tab !== "terminal" && showInspector("terminal")}>
            Terminal
          </button>
        </div>
        <span className="grow" />
        {tab === "changes" && projectId && <OpenIn />}
        {tab === "changes" && (
          <button className="icon-button" title="Refresh" onClick={() => setRefreshKey((k) => k + 1)}>
            <IconRefresh />
          </button>
        )}
      </div>
      <div className="inspector-body" hidden={tab !== "changes"}>
        {tab === "changes" &&
          (projectId ? <DiffPanel projectId={projectId} refreshKey={refreshKey} /> : <div className="diff-summary">Open a project to see its changes.</div>)}
      </div>
      {terminals.map((id) => (
        <div key={id} className="inspector-body terminal-body" hidden={tab !== "terminal" || id !== currentTerminal}>
          <TerminalPanel id={id} cwd={projects.find((p) => p.id === id)?.path ?? null} visible={tab === "terminal" && id === currentTerminal} />
        </div>
      ))}
      {tab === "terminal" && !terminals.includes(currentTerminal) && (
        <div className="inspector-body">
          <button className="button" style={{ margin: 16 }} onClick={() => showInspector("terminal")}>
            Open a terminal here
          </button>
        </div>
      )}
      {browserMounted && (
        <div className="inspector-body browser-body" hidden={tab !== "browser"}>
          <BrowserPanel />
        </div>
      )}
    </aside>
  );
}
