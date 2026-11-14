import { useEffect, useState } from "react";
import { Component } from "lucide-react";
import { designDirName } from "../../../shared/design";
import type { ArtifactFile } from "../../../shared/types";
import { api } from "../api";
import { useStore } from "../store";
import { lineDelta, turnParts, turnTitle, turnVersion, type TurnPart } from "./turn-summary";

const EMPTY: ArtifactFile[] = [];
/** Most chips on the card; the rest are counted. */
const CHIPS_MAX = 8;

/** The design pages a turn wrote, the entry page first. Thread-relative paths. */
export function turnPages(files: readonly ArtifactFile[], threadId: string, turnSeq: number): ArtifactFile[] {
  const dir = `${designDirName(threadId)}/`;
  return files
    .filter((f) => f.path.startsWith(dir) && f.path.endsWith(".html") && !f.path.slice(dir.length).includes("/") && turnVersion(f.versions, turnSeq))
    .sort((a, b) => Number(b.path.endsWith("/index.html")) - Number(a.path.endsWith("/index.html")) || a.path.localeCompare(b.path));
}

interface Loaded {
  title: string | null;
  parts: TurnPart[];
  pages: { path: string; version: number; added: number; removed: number }[];
}

/**
 * A design turn's result in the chat: what the page is built from (`Built from MUI · 6 reused · 1 new`), the parts as
 * chips, and a card per page version it wrote (`Version 3 · +86 −0`) that shows that version on the canvas.
 * Renders nothing for a turn that wrote no page.
 */
export function DesignTurnCard({ threadId, turnSeq, latest }: { threadId: string; turnSeq: number; latest: boolean }) {
  const files = useStore((s) => s.artifactFiles[threadId]) ?? EMPTY;
  const pages = turnPages(files, threadId, turnSeq).slice(0, 3);
  const key = pages.map((p) => `${p.path}@${turnVersion(p.versions, turnSeq)?.version}`).join("|");
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!pages.length) return;
    let live = true;
    const read = (path: string, version: number | null) =>
      version === null ? Promise.resolve(null) : api().readArtifact(threadId, path, version).then((r) => (r.ok && typeof r.text === "string" ? r.text : null), () => null);
    void (async () => {
      const kit = await api().designKitDoc(threadId).catch(() => null);
      const names = Object.fromEntries((kit?.parts ?? []).map((p) => [p.ui, p.name]));
      const out: Loaded = { title: null, parts: [], pages: [] };
      for (const [i, f] of pages.entries()) {
        const at = turnVersion(f.versions, turnSeq)!;
        const [after, before] = await Promise.all([read(f.path, at.version), read(f.path, at.previous)]);
        if (after === null) continue;
        out.pages.push({ path: f.path, version: at.version, ...lineDelta(before, after) });
        if (i === 0 && kit?.kit) {
          out.parts = turnParts(before, after, names).filter((p) => names[p.ui]);
          if (out.parts.length) out.title = turnTitle(out.parts, kit.kit.name, at.previous === null);
        }
      }
      if (live) setLoaded(out);
    })();
    return () => {
      live = false;
    };
    // `key` names the pages and versions: the list itself is a new array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, turnSeq, key]);

  if (!pages.length || !loaded) return null;
  const show = (version: number) => useStore.getState().requestStudio({ threadId, view: "design", version });
  const dir = `${designDirName(threadId)}/`;
  return (
    <div className="design-turn">
      {loaded.title && (
        <div className="design-turn-summary">
          <div className="design-turn-title">
            <Component size={13} strokeWidth={1.75} aria-hidden />
            {loaded.title}
          </div>
          <div className="design-turn-chips">
            {loaded.parts.slice(0, CHIPS_MAX).map((p) => (
              <span key={p.ui} className="design-turn-chip" title={`${p.name}: ${p.count} on the page`}>
                {p.name}
                {p.fresh && <span className="design-turn-new">new</span>}
              </span>
            ))}
            {loaded.parts.length > CHIPS_MAX && <span className="design-turn-chip more">+{loaded.parts.length - CHIPS_MAX}</span>}
          </div>
        </div>
      )}
      {loaded.pages.map((p) => {
        const rel = p.path.slice(dir.length);
        return (
          <button key={p.path} className="design-turn-version" title={`Show version ${p.version} of ${rel} on the canvas`} onClick={() => show(p.version)}>
            {latest ? (
              <span className="design-turn-thumb" aria-hidden>
                <iframe src={`cubiq-design://d/${threadId}/${rel}?v=${p.version}`} sandbox="allow-scripts" tabIndex={-1} loading="lazy" title="" />
              </span>
            ) : (
              <span className="file-card-ext">HTML</span>
            )}
            <span className="file-card-text">
              <span className="file-card-name">{rel}</span>
              <span className="file-card-sub">
                Version {p.version} · <span className="add">+{p.added}</span> <span className="del">−{p.removed}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
