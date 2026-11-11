import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import { useStore } from "../store";

/**
 * The first-run "Download design references" sheet: what the GradientDeck
 * references are, and one download that can be cancelled. It opens itself once
 * when a design thread is selected and the question hasn't been answered.
 */
export function ReferencesSheet() {
  const open = useStore((s) => s.referencesSheetOpen);
  const setOpen = useStore((s) => s.setReferencesSheetOpen);
  const selectedThreadId = useStore((s) => s.selectedThreadId);
  const asked = useRef(false);
  const unsubscribe = useRef<(() => void) | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedThreadId || asked.current) return;
    const s = useStore.getState();
    const thread = Object.values(s.threads)
      .flat()
      .find((t) => t.id === selectedThreadId);
    if (thread?.kind !== "design" || s.settings?.designReferencesAsked === true) return;
    asked.current = true;
    void api()
      .designReferences()
      .then((status) => {
        if (status.state === "none") setOpen(true);
      })
      .catch(() => {});
  }, [selectedThreadId, setOpen]);

  useEffect(() => {
    if (open) return;
    setDownloading(false);
    setProgress(null);
    setError(null);
  }, [open]);

  useEffect(
    () => () => {
      unsubscribe.current?.();
      unsubscribe.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!downloading) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, downloading, setOpen]);

  if (!open) return null;

  const markAsked = () => {
    void api()
      .updateSettings({ designReferencesAsked: true })
      .then((s) => useStore.setState({ settings: s }))
      .catch(() => {});
  };

  const start = () => {
    markAsked();
    setDownloading(true);
    setProgress(null);
    setError(null);
    unsubscribe.current?.();
    unsubscribe.current = api().onDesignReferenceProgress((p) => setProgress({ done: p.done, total: p.total }));
    void api()
      .designReferencesDownload()
      .then((res) => {
        unsubscribe.current?.();
        unsubscribe.current = null;
        if (res.ok) {
          setOpen(false);
          const count = res.status.state === "installed" ? res.status.count : 0;
          useStore.getState().showNotice("Design references downloaded: " + count + " styles.");
          return;
        }
        if (res.code === "cancelled") {
          setOpen(false);
          return;
        }
        setDownloading(false);
        setProgress(null);
        setError(res.message);
      })
      .catch((err: unknown) => {
        unsubscribe.current?.();
        unsubscribe.current = null;
        setDownloading(false);
        setProgress(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const actions: CSSProperties = { display: "flex", gap: 8, justifyContent: "flex-end" };

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !downloading && setOpen(false)}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Download design references">
        <div className="sheet-head">
          <h2>Download design references</h2>
        </div>
        <p>
          1,295 real-site design references from GradientDeck: each site's colours, type, spacing and components, written up as text. CubiQ adapts one into your design's
          theme when you or the agent pick it.
        </p>
        <p className="note">About 43 MB, text only (no images or fonts). Saved in CubiQ's data folder; nothing is sent about you or your designs.</p>
        {downloading ? (
          <>
            <p className="note" role="status">
              {total > 0 ? `Downloading… ${done.toLocaleString()} of ${total.toLocaleString()}` : "Starting…"}
            </p>
            <span className="sp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
              <span style={{ display: "block", height: "100%", width: pct + "%", background: "var(--text)", borderRadius: "inherit" }} />
            </span>
            <div style={{ ...actions, marginTop: 12 }}>
              <button className="button ghost" onClick={() => void api().designReferencesCancel()}>
                Cancel
              </button>
            </div>
          </>
        ) : error ? (
          <>
            <p className="note" role="alert">
              {error}
            </p>
            <div style={actions}>
              <button className="button ghost" onClick={() => setOpen(false)}>
                Close
              </button>
              <button className="button primary" onClick={start}>
                Retry
              </button>
            </div>
          </>
        ) : (
          <div style={actions}>
            <button
              className="button ghost"
              onClick={() => {
                markAsked();
                setOpen(false);
              }}
            >
              Not now
            </button>
            <button className="button primary" autoFocus onClick={start}>
              Download
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
