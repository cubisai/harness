import { useCallback, useEffect, useState } from "react";
import type { DiffFile } from "../../../shared/types";
import { api } from "../api";
import { IconChevron, IconOpen } from "../icons";
import { useStore } from "../store";

/** The working tree's changes against HEAD, refreshed after every turn. */
export function DiffPanel({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const diffVersion = useStore((s) => s.diffVersion);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    void api().getDiff(projectId).then(setFiles);
  }, [projectId]);
  useEffect(load, [load, diffVersion, refreshKey]);

  const adds = files?.reduce((n, f) => n + f.additions, 0) ?? 0;
  const dels = files?.reduce((n, f) => n + f.deletions, 0) ?? 0;

  if (files === null) return <div className="diff-summary">Loading…</div>;
  if (files.length === 0) return <div className="diff-summary">No uncommitted changes.</div>;
  return (
    <>
      <div className="diff-summary">
        {files.length} file{files.length === 1 ? "" : "s"} changed · <span style={{ color: "var(--success)" }}>+{adds}</span>{" "}
        <span style={{ color: "var(--danger)" }}>−{dels}</span>
      </div>
      {files.map((f) => {
        const open = !closed[f.path];
        return (
          <div className="diff-file" key={f.path}>
            <div className="diff-file-bar">
              <button className="diff-file-head" onClick={() => setClosed((c) => ({ ...c, [f.path]: open }))}>
                <IconChevron open={open} />
                <span className="path" title={f.path}>
                  {f.path}
                </span>
                {f.status !== "modified" && <span className="badge">{f.status === "untracked" ? "new" : f.status}</span>}
                <span className="adds">+{f.additions}</span>
                <span className="dels">−{f.deletions}</span>
              </button>
              {f.status !== "deleted" && (
                <button className="icon-button file-open" title="Open in editor" onClick={() => void useStore.getState().openInEditor({ path: f.path, line: firstLine(f) })}>
                  <IconOpen />
                </button>
              )}
            </div>
            {open && (
              <div className="diff-lines">
                {f.hunks.map((h, i) => (
                  <div key={i}>
                    <button
                      className="hunk"
                      title="Open here in the editor"
                      onClick={() => void useStore.getState().openInEditor({ path: f.path, line: hunkLine(h.header) })}
                    >
                      {h.header}
                    </button>
                    {h.lines.map((l, j) => (
                      <div key={j} className={`line ${l.kind}`}>
                        {l.text}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** The new file's line a hunk starts at: "@@ -39,7 +42,8 @@" is line 42. */
export function hunkLine(header: string): number | undefined {
  const m = /\+(\d+)/.exec(header);
  return m ? Math.max(1, Number(m[1])) : undefined;
}

function firstLine(f: DiffFile): number | undefined {
  return f.hunks[0] ? hunkLine(f.hunks[0].header) : undefined;
}
