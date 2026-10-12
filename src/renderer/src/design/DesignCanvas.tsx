import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Columns2, Download, FolderOpen, Grid3x3 } from "lucide-react";
import type { DesignEntry, DesignExportFormat } from "../../../shared/types";
import { api } from "../api";
import { fileManagerName } from "../components/OpenIn";
import { Select } from "../components/Select";
import { IconClose, IconRefresh, IconTarget } from "../icons";
import "../styles/artifact.css";
import { useStore } from "../store";
import { VIEWPORTS, ZOOMS, frameLayout, pageFromPath, readBridgeMessage, type Viewport, type Zoom } from "./frame";
import { announceSelection, elementLabel, selectionKey, type SelectedElement } from "../../../shared/selection";
import { compareCells, pageOptions, sameEntry, type CompareCell } from "./pages";
import { currentTweakValues, parseTweaks, tweakTarget, tweakValue, type Tweak, type TweakValues } from "../../../shared/tweaks";
import { TweaksPanel } from "./TweaksPanel";

const ipcError = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

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
  // The page asked for (null = the entry file), the side-by-side view, and the last promote's outcome.
  const [page, setPage] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  // The page's declared tweaks with the values it loaded with, and the user's unkept changes per page.
  const [tweaks, setTweaks] = useState<{ list: Tweak[]; base: TweakValues } | null>(null);
  const [overrides, setOverrides] = useState<Record<string, TweakValues>>({});
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [keeping, setKeeping] = useState(false);
  // The canvas selection lives in the store (the composer shows it as chips); the frame draws it.
  const selection = useStore((s) => s.designSelection[threadId]);
  const setSelection = useStore((s) => s.setDesignSelection);
  const selected = selection?.elements ?? [];
  const selectedKey = selectionKey(selected);
  // What the frame last reported, so a change made here (a chip's ×) is sent down once and no echo loops back.
  const fromFrame = useRef("");
  const [announcement, setAnnouncement] = useState("");
  const options = entry ? pageOptions(entry.pages) : [];
  const cells = entry ? compareCells(entry.pages) : [];
  const comparing = compare && cells.length > 0 && version === 0;

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
    setPage(null);
    setCompare(false);
    setNotice(null);
    setTweaks(null);
    setOverrides({});
    setTweaksOpen(false);
    scroll.current = { x: 0, y: 0 };
  }, [threadId]);

  // Which page to show: asked again whenever the folder changes (the agent may have just written the first one).
  useEffect(() => {
    let live = true;
    void api()
      .designEntry(threadId, page)
      .then((e) => {
        if (!live) return;
        setEntry((prev) => (sameEntry(prev, e) ? prev : e));
        setLoaded(true);
      })
      .catch(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [threadId, reload, manual, page]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entry !== null, comparing]);

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
        // A fresh load: its tweaks (if any) arrive right after.
        setTweaks(null);
        // A link inside the page went to another page of the design: follow it (title, versions, export) without
        // loading it a second time.
        const at = msg.path ? pageFromPath(msg.path, threadId) : null;
        const to = at && entry && at !== entry.rel && version === 0 ? entry.pages.find((p) => p.rel === at) : undefined;
        if (to) {
          if (frameRef.current) frameRef.current.dataset.src = to.url;
          scroll.current = { x: 0, y: 0 };
          setPage(to.rel);
        } else if (scroll.current.x || scroll.current.y) post({ type: "restore-scroll", ...scroll.current });
        if (picking) post({ type: "pick", on: true });
        // A reload (the agent rewrote the page): find the selection again; anything gone is dropped and reported.
        const sel = useStore.getState().designSelection[threadId];
        if (sel && entry && sel.page === (to?.rel ?? entry.rel) && version === 0) {
          fromFrame.current = "";
          post({ type: "set-selection", targets: sel.elements.map(({ id, selector, tag, text }) => ({ id, selector, tag, text })) });
        }
      } else if (msg.type === "tweaks") {
        const list = parseTweaks(msg.manifest);
        if (!list.length) return setTweaks(null);
        const base = currentTweakValues(list, msg.attrs, msg.vars);
        setTweaks({ list, base });
        // The page reloaded (the agent wrote, or Reload): put this page's unkept changes back.
        const mine = entry ? overridesRef.current[entry.rel] : undefined;
        for (const t of list) {
          const v = mine?.[t.id] !== undefined ? tweakValue(t, mine[t.id]) : null;
          if (v !== null && v !== base[t.id]) post({ type: "set-tweak", ...tweakTarget(t, v) });
        }
      } else if (msg.type === "scroll") {
        scroll.current = { x: msg.x, y: msg.y };
      } else if (msg.type === "selection") {
        if (!entry) return;
        fromFrame.current = selectionKey(msg.elements);
        setSelection(threadId, { page: entry.rel, elements: msg.elements });
        setAnnouncement(announceSelection(msg.elements));
        if (msg.lost > 0)
          setNotice({ text: `${msg.lost === 1 ? "A selected element is" : `${msg.lost} selected elements are`} no longer on the page, so the selection dropped ${msg.lost === 1 ? "it" : "them"}.` });
      } else {
        setPicking(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [entry, picking, post, threadId, version, setSelection]);

  // A change made outside the frame (a chip removed in the composer, the selection cleared after sending) is drawn there.
  useEffect(() => {
    if (selectedKey === fromFrame.current) return;
    fromFrame.current = selectedKey;
    const els = useStore.getState().designSelection[threadId]?.elements ?? [];
    post(els.length ? { type: "set-selection", targets: els.map(({ id, selector, tag, text }) => ({ id, selector, tag, text })) } : { type: "clear-selection" });
  }, [selectedKey, threadId, post]);

  // A selection belongs to one page: moving to another page (or another version) lets it go.
  useEffect(() => {
    if (selection && entry && (selection.page !== entry.rel || version !== 0)) setSelection(threadId, null);
  }, [selection, entry, version, threadId, setSelection]);

  const clearSelection = () => {
    setSelection(threadId, null);
    setAnnouncement(announceSelection([]));
  };
  // A breadcrumb step selects that ancestor instead.
  const selectAncestor = (step: SelectedElement["path"][number]) => {
    const [tag = "div", id] = step.label.split(" ");
    fromFrame.current = "";
    post({ type: "set-selection", targets: [{ id, selector: step.selector, tag, text: "" }] });
  };

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

  // Esc in the app (focus outside the frame) works like Esc in it: first it clears the selection, then it stops selecting.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (useStore.getState().designSelection[threadId]) {
        useStore.getState().setDesignSelection(threadId, null);
        setAnnouncement(announceSelection([]));
        return;
      }
      setPicking(false);
      post({ type: "pick", on: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking, post, threadId]);

  const path = entry ? `${entry.dir}/${entry.rel}` : null;
  const versions = (files?.find((f) => f.path === path)?.versions ?? []).slice().sort((a, b) => b.version - a.version);
  const src = entry ? (version ? `${entry.url}?v=${version}` : entry.url) : null;
  // The latest file remounts on every change; a saved version stays put.
  const frameKey = version ? `v${version}` : `live-${reload}-${manual}`;
  const layout = frameLayout(viewport, zoom, stage);
  const fit = viewport === "fit";
  // Exports lay the page out at the viewport on screen; Fit exports at desktop width.
  const exportWidth = VIEWPORTS.find((v) => v.value === viewport)?.size?.width ?? 1440;

  // The frame's address is set by hand, so a page the frame reached by a link isn't loaded again when the canvas
  // follows it (a remount is a new frame, so it always loads).
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !src || frame.dataset.src === src) return;
    frame.dataset.src = src;
    frame.src = src;
  }, [src, frameKey, comparing]);

  const rel = entry?.rel ?? null;
  const pageOverrides = (rel && overrides[rel]) || {};
  const tweakValues: TweakValues = tweaks ? { ...tweaks.base, ...pageOverrides } : {};
  const tweaksDirty = !!tweaks && Object.entries(pageOverrides).some(([id, v]) => id in tweaks.base && tweaks.base[id] !== v);
  const showTweaks = !!tweaks && !!entry && version === 0 && !comparing;

  const changeTweak = (t: Tweak, raw: string) => {
    const v = tweakValue(t, raw);
    if (v === null || !rel) return;
    setOverrides((o) => ({ ...o, [rel]: { ...o[rel], [t.id]: v } }));
    post({ type: "set-tweak", ...tweakTarget(t, v) });
  };
  const resetTweaks = () => {
    if (!rel) return;
    setOverrides((o) => {
      const next = { ...o };
      delete next[rel];
      return next;
    });
    setManual((n) => n + 1);
  };
  const keepTweaks = async () => {
    if (!rel) return;
    setKeeping(true);
    try {
      await api().designKeepTweaks(threadId, rel, tweakValues);
      setOverrides((o) => {
        const next = { ...o };
        delete next[rel];
        return next;
      });
      setTweaksOpen(false);
      setNotice({ text: `Kept the tweaks in ${rel}. The previous page is saved as a version.` });
    } catch (err) {
      setNotice({ text: `Couldn't keep the tweaks: ${ipcError(err)}`, error: true });
    } finally {
      setKeeping(false);
    }
  };

  const promote = async (cell: CompareCell) => {
    setPromoting(cell.rel);
    try {
      await api().designPromote(threadId, cell.rel);
      setCompare(false);
      setPage("index.html");
      setNotice({ text: `${cell.label} is now index.html. The previous page is saved as a version.` });
    } catch (err) {
      setNotice({ text: `Couldn't use ${cell.label}: ${ipcError(err)}`, error: true });
    } finally {
      setPromoting(null);
    }
  };

  const runExport = async (format: DesignExportFormat) => {
    setExportOpen(false);
    if (!entry) return;
    setExporting(format);
    try {
      const path = await api().designExport(threadId, format, { rel: entry.rel, version: version || null, width: exportWidth });
      if (path) setExported({ path });
    } catch (err) {
      setExported({ error: ipcError(err) });
    } finally {
      setExporting(null);
    }
  };

  return (
    <section className="design-canvas" aria-label="Design canvas">
      <header className="design-canvas-head drag">
        {entry && options.length > 1 && !comparing ? (
          <span className="design-canvas-title">
            <Select<string>
              value={entry.rel}
              options={options}
              onChange={(rel) => {
                setVersion(0);
                scroll.current = { x: 0, y: 0 };
                setPage(rel);
              }}
              ariaLabel="Page"
              className="ghost-select"
            />
          </span>
        ) : (
          <span className="design-canvas-title" title={path ?? undefined}>
            {comparing ? `Comparing ${cells.length}` : entry ? entry.rel : "Canvas"}
          </span>
        )}
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
          {showTweaks && (
            <TweaksPanel
              tweaks={tweaks.list}
              values={tweakValues}
              dirty={tweaksDirty}
              keeping={keeping}
              open={tweaksOpen}
              onOpen={setTweaksOpen}
              onChange={changeTweak}
              onReset={resetTweaks}
              onKeep={() => void keepTweaks()}
            />
          )}
          {cells.length > 0 && (
            <button
              className={`icon-button${comparing ? " active" : ""}`}
              title={comparing ? "Back to one page" : "Compare options side by side"}
              aria-label="Compare options"
              aria-pressed={comparing}
              onClick={() => {
                if (!comparing && picking) {
                  setPicking(false);
                  post({ type: "pick", on: false });
                }
                setVersion(0);
                setCompare(!comparing);
              }}
            >
              <Columns2 size={16} strokeWidth={1.75} aria-hidden />
            </button>
          )}
          <button
            className={`icon-button${picking ? " active" : ""}`}
            title={picking ? "Selecting: click an element, Shift-click for more (Esc clears, then stops)" : "Select elements to change"}
            aria-label={selected.length ? `Select elements (${selected.length} selected)` : "Select elements"}
            aria-pressed={picking}
            onClick={togglePick}
            disabled={!entry || version !== 0 || comparing}
          >
            <IconTarget />
            {selected.length > 0 && <span className="design-select-count">{selected.length}</span>}
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
      <div className="design-live" aria-live="polite">
        {announcement}
      </div>
      {selected.length > 0 && !comparing && version === 0 && (
        <nav className="design-crumbs" aria-label="Selection">
          {selected.length === 1 ? (
            <>
              {selected[0]!.path.map((step) => (
                <span key={step.selector} className="design-crumb-step">
                  <button className="design-crumb" title={`Select ${step.label}`} onClick={() => selectAncestor(step)}>
                    {step.label}
                  </button>
                  <span className="design-crumb-sep" aria-hidden>
                    ›
                  </span>
                </span>
              ))}
              <span className="design-crumb current" title={selected[0]!.selector}>
                {elementLabel(selected[0]!)}
              </span>
            </>
          ) : (
            <span className="design-crumb current">{selected.length} elements selected</span>
          )}
          <span className="grow" />
          <button className="button ghost" onClick={clearSelection}>
            Clear
          </button>
        </nav>
      )}
      {notice && (
        <div className={`design-version-bar${notice.error ? " error" : ""}`} role="status">
          <span title={notice.text}>{notice.text}</span>
          <button className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => setNotice(null)}>
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
      {comparing ? (
        <div className="design-compare" role="list" aria-label="Options side by side">
          {cells.map((cell) => (
            <CompareFrame
              key={`${cell.rel}-${reload}-${manual}`}
              cell={cell}
              size={VIEWPORTS.find((v) => v.value === viewport)?.size ?? { width: 1440, height: 900 }}
              busy={promoting !== null}
              onOpen={() => {
                setCompare(false);
                scroll.current = { x: 0, y: 0 };
                setPage(cell.rel);
              }}
              onUse={() => void promote(cell)}
            />
          ))}
        </div>
      ) : entry && src ? (
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

/**
 * One option in the compare view: the page in its own sandboxed frame, laid out at the canvas's viewport (Fit =
 * desktop) and scaled down to the cell, with Open and, for a variant, Use this.
 */
function CompareFrame({ cell, size, busy, onOpen, onUse }: { cell: CompareCell; size: { width: number; height: number }; busy: boolean; onOpen: () => void; onUse: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = width > 0 ? Math.min(1, width / size.width) : 0;
  return (
    <div className="design-compare-cell" role="listitem" aria-label={cell.label}>
      <div className="design-compare-head">
        <span className="design-compare-label" title={cell.rel}>
          {cell.label}
        </span>
        <button className="button ghost" onClick={onOpen}>
          Open
        </button>
        {cell.variant && (
          <button className="button ghost" onClick={onUse} disabled={busy} title={`Make ${cell.rel} the design's index.html`}>
            Use this
          </button>
        )}
      </div>
      <div className="design-compare-frame" ref={boxRef} style={{ aspectRatio: `${size.width} / ${size.height}` }}>
        {scale > 0 && (
          <iframe
            className="design-frame"
            title={`Design: ${cell.rel}`}
            src={cell.url}
            sandbox="allow-scripts"
            style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
          />
        )}
      </div>
    </div>
  );
}
