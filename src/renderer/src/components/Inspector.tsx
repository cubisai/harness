import { useState } from "react";
import { IconRefresh } from "../icons";
import { useStore } from "../store";
import { BrowserPanel } from "./BrowserPanel";
import { OpenIn } from "./OpenIn";
import { DiffPanel } from "./DiffPanel";

/** The right-hand panel: Changes and Browser. The browser stays mounted once opened, so its page survives tab switches. */
export function Inspector({ projectId }: { projectId: string | null }) {
  const tab = useStore((s) => s.inspectorTab);
  const browserMounted = useStore((s) => s.browserMounted);
  const showInspector = useStore((s) => s.showInspector);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <aside className="inspector" id="inspector">
      <div className="inspector-head drag">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={tab === "changes"} aria-controls="inspector-changes" className={tab === "changes" ? "on" : ""} onClick={() => tab !== "changes" && showInspector("changes")}>
            Changes
          </button>
          <button role="tab" aria-selected={tab === "browser"} aria-controls="inspector-browser" className={tab === "browser" ? "on" : ""} onClick={() => tab !== "browser" && showInspector("browser")}>
            Browser
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
      <div className="inspector-body" id="inspector-changes" role="tabpanel" hidden={tab !== "changes"}>
        {tab === "changes" &&
          (projectId ? <DiffPanel projectId={projectId} refreshKey={refreshKey} /> : <div className="diff-summary">Open a project to see its changes.</div>)}
      </div>
      {browserMounted && (
        <div className="inspector-body browser-body" id="inspector-browser" role="tabpanel" hidden={tab !== "browser"}>
          <BrowserPanel />
        </div>
      )}
    </aside>
  );
}
