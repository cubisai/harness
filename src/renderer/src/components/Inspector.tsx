import { useState } from "react";
import { api } from "../api";
import { IconRefresh } from "../icons";
import { useStore } from "../store";
import { ArtifactPanel } from "./ArtifactPanel";
import { fileManagerName } from "./OpenIn";
import { BrowserPanel } from "./BrowserPanel";
import { FilesPanel } from "./FilesPanel";
import { OpenIn } from "./OpenIn";
import { DiffPanel } from "./DiffPanel";

/** The right-hand panel: Changes, Browser, Files, and the File an agent wrote. The browser stays mounted once opened, so its page survives tab switches. */
export function Inspector({ projectId }: { projectId: string | null }) {
  const tab = useStore((s) => s.inspectorTab);
  const artifact = useStore((s) => s.artifact);
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
          {projectId && (
            <button role="tab" aria-selected={tab === "files"} aria-controls="inspector-files" className={tab === "files" ? "on" : ""} onClick={() => tab !== "files" && showInspector("files")}>
              Files
            </button>
          )}
          {artifact && (
            <button role="tab" aria-selected={tab === "artifact"} aria-controls="inspector-artifact" className={tab === "artifact" ? "on" : ""} onClick={() => tab !== "artifact" && showInspector("artifact")}>
              File
            </button>
          )}
        </div>
        <span className="grow" />
        {tab === "changes" && projectId && <OpenIn />}
        {(tab === "changes" || tab === "files") && (
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
      <div className="inspector-body" id="inspector-files" role="tabpanel" hidden={tab !== "files"}>
        {tab === "files" && projectId && <FilesPanel projectId={projectId} refreshKey={refreshKey} />}
      </div>
      {artifact && tab === "artifact" && (
        <div className="inspector-body artifact-body" id="inspector-artifact" role="tabpanel">
          <ArtifactTab threadId={artifact.threadId} path={artifact.path} />
        </div>
      )}
    </aside>
  );
}

function ArtifactTab({ threadId, path }: { threadId: string; path: string }) {
  const files = useStore((s) => s.artifactFiles[threadId]) ?? [];
  const root = useStore((s) => {
    const thread = Object.values(s.threads).flat().find((t) => t.id === threadId);
    return thread?.worktreePath ?? s.projects.find((p) => p.id === thread?.projectId)?.path ?? null;
  });
  const { openArtifact, closeArtifact, openInEditor } = useStore.getState();
  const abs = (p: string) => (/^([a-z]:[\\/]|\/)/i.test(p) || !root ? p : `${root}/${p}`);
  return (
    <ArtifactPanel
      key={threadId}
      threadId={threadId}
      files={files}
      path={path}
      onSelectPath={(p) => openArtifact(p, threadId)}
      onClose={closeArtifact}
      onOpenInEditor={(p) => void openInEditor({ path: abs(p) })}
      onReveal={(p) => void api().revealPath(abs(p))}
      fileManager={fileManagerName()}
    />
  );
}
