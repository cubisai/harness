import { useEffect } from "react";
import type { ScreenshotInfo } from "../../../shared/types";

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/** The row of thumbnails under the page, oldest first, newest last. */
export function ScreenshotStrip({ shots, onOpen }: { shots: ScreenshotInfo[]; onOpen(shot: ScreenshotInfo): void }) {
  if (!shots.length) return null;
  return (
    <div className="shot-strip" role="list" aria-label="Screenshots">
      {shots.map((shot, i) => (
        <button key={shot.path} role="listitem" className="shot" title={basename(shot.path)} onClick={() => onOpen(shot)}>
          <img src={shot.url} alt={`Screenshot ${i + 1}`} loading="lazy" />
        </button>
      ))}
    </div>
  );
}

/** A shot at full size; the backdrop or Escape closes it. */
export function ScreenshotViewer({ shot, onClose }: { shot: ScreenshotInfo | null; onClose(): void }) {
  useEffect(() => {
    if (!shot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shot, onClose]);
  if (!shot) return null;
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <figure className="shot-viewer">
        <img src={shot.url} alt="Screenshot" />
        <figcaption>{shot.path}</figcaption>
      </figure>
    </div>
  );
}
