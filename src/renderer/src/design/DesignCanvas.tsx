import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download, FolderOpen, Grid3x3 } from "lucide-react";
import type { DesignEntry, DesignExportFormat } from "../../../shared/types";
import { api } from "../api";
import { fileManagerName } from "../components/OpenIn";
import { Select } from "../components/Select";
import { IconClose, IconRefresh, IconTarget } from "../icons";
import "../styles/artifact.css";
import { useStore } from "../store";
import { VIEWPORTS, ZOOMS, frameLayout, pickChipText, readBridgeMessage, type Viewport, type Zoom } from "./frame";

/**
 * A design thread's canvas: the agent's page in a sandboxed frame (scripts on, no network, no app access), reloaded
 * as its folder changes, with viewport, zoom, an 8px grid, saved versions and pick-to-comment. Loaded only when a
 * design thread opens, so the Chat bundle stays as it was.
 */
export default function DesignCanvas({ threadId }: { threadId: string }) {
  const reload = useStore((s) => s.designReload[threadId] ?? 0);
  const files = useStore((s) => s.artifactFiles[threadId]);
  const [entry, setEntry] = useState<DesignEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [viewport, setViewport] = useState<Viewport>("fit");
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [grid, setGrid] = useState(false);
  const [picking, setPicking] = useState(false);
  // 0 = the file as it is now; N = its saved version N (live reload pauses).
  const [version, setVersion] = useState(0);
  const [manual, setManual] = useState(0);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scroll = useRef({ x: 0, y: 0 });
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<DesignExportFormat | null>(null);
  const [exported, setExported] = useState<{ path: string } | { error: string } | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  // Watch the folder while the canvas is open; the main process counts watches per window.
  useEffect(() => {
    void api().designWatch(threadId);
    return () => void api().designUnwatch(threadId);
  }, [threadId]);

  // A new thread starts fresh.
  useEffect(() => {
    setVersion(0);
    setPicking(false);
    setExported(null);
    scroll.current = { x: 0, y: 0 };
  }, [threadId]);

  // Which page to show: asked again whenever the folder changes (the agent may have just written the first one).
  useEffect(() => {
    let live = true;
    void api()
      .designEntry(threadId)
      .then((e) => {
        if (!live) return;
        setEntry((prev) => (prev && e && prev.url === e.url ? prev : e));
        setLoaded(true);
      })
      .catch(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [threadId, reload, manual]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entry !== null]);

  const post = useCallback((msg: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ source: "cubiq-canvas", ...msg }, "*");
  }, []);

  // Only the frame's own window is listened to, and every message is checked (the page is the agent's code).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const msg = readBridgeMessage(e.data);
      if (!msg) return;
      if (msg.type === "ready") {
        if (scroll.current.x || scroll.current.y) post({ type: "restore-scroll", ...scroll.current });
        if (picking) post({ type: "pick", on: true });
      } else if (msg.type === "scroll") {
        scroll.current = { x: msg.x, y: msg.y };
      } else if (msg.type === "picked") {
        setPicking(false);
        const page = entry ? `${entry.dir}/${entry.rel}` : "the design";
        useStore.setState((s) => ({ composerInsert: { text: pickChipText(msg.element, page), nonce: (s.composerInsert?.nonce ?? 0) + 1 } }));
      } else {
        setPicking(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [entry, picking, post]);

  // The Export menu closes on a click outside it or Esc.
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setExportOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [exportOpen]);

  const togglePick = () => {
    const on = !picking;
    setPicking(on);
    post({ type: "pick", on });
  };

  // Esc in the app (focus outside the frame) also ends picking.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPicking(false);
      post({ type: "pick", on: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking, post]);

  const path = entry ? `${entry.dir}/${entry.rel}` : null;
  const versions = (files?.find((f) => f.path === path)?.versions ?? []).slice().sort((a, b) => b.version - a.version);
  const src = entry ? (version ? `${entry.url}?v=${version}` : entry.url) : null;
  // The latest file remounts on every change; a saved version stays put.
  const frameKey = version ? `v${version}` : `live-${reload}-${manual}`;
  const layout = frameLayout(viewport, zoom, stage);
  const fit = viewport === "fit";
  // Exports lay the page out at the viewport on screen; Fit exports at desktop width.
  const exportWidth = VIEWPORTS.find((v) => v.value === viewport)?.size?.width ?? 1440;

  const runExport = async (format: DesignExportFormat) => {
    setExportOpen(false);
    if (!entry) return;
    setExporting(format);
    try {
      const path = await api().designExport(threadId, format, { rel: entry.rel, version: version || null, width: exportWidth });
      if (path) setExported({ path });
    } catch (err) {
      setExported({ error: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err) });
    } finally {
      setExporting(null);
    }
  };

  return (
    <section className="design-canvas" aria-label="Design canvas">
      <header className="design-canvas-head drag">
        <span className="design-canvas-title" title={path ?? undefined}>
          {entry ? entry.rel : "Canvas"}
        </span>
        <div className="design-tools">
          <Select<Viewport> value={viewport} options={VIEWPORTS.map(({ value, label, detail }) => ({ value, label, detail }))} onChange={setViewport} ariaLabel="Viewport" className="ghost-select" />
          {!fit && <Select<Zoom> value={zoom} options={ZOOMS} onChange={setZoom} ariaLabel="Zoom" className="ghost-select" />}
          {versions.length > 0 && (
            <Select<number>
              value={version}
              options={[{ value: 0, label: "Latest" }, ...versions.map((v) => ({ value: v.version, label: `v${v.version}` }))]}
              onChange={setVersion}
              ariaLabel="Version"
              className="ghost-select"
            />
          )}
          <button className={`icon-button${grid ? " active" : ""}`} title="8px grid" aria-pressed={grid} onClick={() => setGrid(!grid)}>
            <Grid3x3 size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            className={`icon-button${picking ? " active" : ""}`}
            title={picking ? "Picking: click an element (Esc to stop)" : "Pick an element to comment on"}
            aria-pressed={picking}
            onClick={togglePick}
            disabled={!entry || version !== 0}
          >
            <IconTarget />
          </button>
          <button className="icon-button" title="Reload" onClick={() => setManual((n) => n + 1)} disabled={!entry}>
            <IconRefresh />
          </button>
          <button className="icon-button" title="Open the design folder" onClick={() => void api().designReveal(threadId)}>
            <FolderOpen size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <div className="artifact-menu-wrap" ref={exportRef}>
            <button
              className={`icon-button${exportOpen ? " active" : ""}`}
              title={exporting ? `Exporting ${exporting.toUpperCase()}…` : version ? `Export v${version}` : "Export"}
              aria-label="Export"
              aria-haspopup="menu"
              aria-expanded={exportOpen}
              onClick={() => setExportOpen(!exportOpen)}
              disabled={!entry || exporting !== null}
            >
              <Download size={16} strokeWidth={1.75} aria-hidden />
            </button>
            {exportOpen && (
              <div className="artifact-menu design-export-menu" role="menu">
                <button role="menuitem" onClick={() => void runExport("html")}>
                  <span className="artifact-menu-label">HTML</span>
                  <span className="design-export-sub">One file, works offline</span>
                </button>
                <button role="menuitem" onClick={() => void runExport("png")}>
                  <span className="artifact-menu-label">PNG</span>
                  <span className="design-export-sub">Full page, {exportWidth} wide</span>
                </button>
                <button role="menuitem" onClick={() => void runExport("pdf")}>
                  <span className="artifact-menu-label">PDF</span>
                  <span className="design-export-sub">Slides print one per page</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      {exported && (
        <div className={`design-version-bar${"error" in exported ? " error" : ""}`} role="status">
          <span title={"path" in exported ? exported.path : exported.error}>
            {"path" in exported ? `Exported ${exported.path.split(/[\\/]/).pop()}` : `Export failed: ${exported.error}`}
          </span>
          {"path" in exported && (
            <button className="button ghost" onClick={() => void api().revealPath(exported.path)}>
              Show in {fileManagerName()}
            </button>
          )}
          <button className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => setExported(null)}>
            <IconClose />
          </button>
        </div>
      )}
      {version !== 0 && (
        <div className="design-version-bar">
          <span>
            Viewing v{version}. Linked files show as they are now.
          </span>
          <button className="button ghost" onClick={() => setVersion(0)}>
            Back to latest
          </button>
        </div>
      )}
      {entry && src ? (
        <div className={`design-stage${fit ? " fit" : ""}`} ref={stageRef}>
          <div
            className="design-frame-box"
            style={fit ? undefined : { width: layout.width * layout.scale, height: layout.height * layout.scale }}
          >
            <iframe
              key={frameKey}
              ref={frameRef}
              className="design-frame"
              title={`Design: ${entry.rel}`}
              src={src}
              sandbox="allow-scripts"
              style={fit ? undefined : { width: layout.width, height: layout.height, transform: `scale(${layout.scale})` }}
            />
            {grid && <div className="design-grid" style={{ backgroundSize: `${8 * layout.scale}px ${8 * layout.scale}px` }} aria-hidden />}
          </div>
        </div>
      ) : (
        <div className="design-canvas-empty">
          {loaded && (
            <div>
              <h2>Nothing to show yet</h2>
              <p>Your design appears here once the agent writes it.</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
