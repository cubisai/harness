import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Columns2, Download, Eraser, FolderOpen, Grid3x3, Hammer, LayoutGrid, MessageSquarePlus, MousePointer2, Pencil, Play, SlidersHorizontal, Smartphone, Type, Undo2, Workflow } from "lucide-react";
import type { DesignEntry, DesignExportFormat } from "../../../shared/types";
import { api } from "../api";
import { fileManagerName } from "../components/OpenIn";
import { Select } from "../components/Select";
import { IconClose, IconRefresh, IconTarget } from "../icons";
import "../styles/artifact.css";
import { useStore } from "../store";
import { VIEWPORTS, ZOOMS, deviceFor, frameLayout, pageFromPath, readBridgeMessage, type OutlineNode, type Viewport, type Zoom } from "./frame";
import { DrawOverlay, type Stroke } from "./DrawOverlay";
import { announceSelection, elementLabel, selectionKey, type SelectedElement } from "../../../shared/selection";
import { compareCells, pageOptions, sameEntry, type CompareCell } from "./pages";
import { changedTweaks, currentTweakValues, parseTweaks, tweakTarget, tweakValue, type Tweak, type TweakValues } from "../../../shared/tweaks";
import { TweaksBody, TweaksPanel } from "./TweaksPanel";
import { ElementsTree } from "./ElementsTree";
import { DEFAULT_TIER, tierFeatures, tierOf } from "../../../shared/tiers";
import { commentsMessage, type DesignComment } from "../../../shared/comments";
import { CommentsPanel } from "./CommentsPanel";
import { flowOrder } from "./board-layout";
import { Board } from "./Board";
import { Present } from "./Present";
import { InspectorPanel } from "./InspectorPanel";

const ipcError = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

/** `backgroundColor` → `background-color`, for the Apply message's human-readable change list. */
const kebab = (prop: string): string => prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * A design thread's canvas: the agent's page in a sandboxed frame (scripts on, no network, no app access), reloaded
 * as its folder changes, with viewport, zoom, an 8px grid, saved versions and pick-to-comment. Loaded only when a
 * design thread opens, so the Chat bundle stays as it was.
 */
/** Extra room the device chrome needs around a frame (both sides together, in stage px, beyond the usual padding). */
const DEVICE_CHROME = { none: { width: 0, height: 0 }, phone: { width: 40, height: 40 }, tablet: { width: 56, height: 56 }, browser: { width: 18, height: 54 } } as const;

export default function DesignCanvas({ threadId }: { threadId: string }) {
  const reload = useStore((s) => s.designReload[threadId] ?? 0);
  const files = useStore((s) => s.artifactFiles[threadId]);
  const [entry, setEntry] = useState<DesignEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [viewport, setViewport] = useState<Viewport>("fit");
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [grid, setGrid] = useState(false);
  const [picking, setPicking] = useState(false);
  // The floating bar's chosen tool (null = none), the pen strokes over the frame, and the device frame around it.
  const [tool, setTool] = useState<"select" | "text" | "comment" | "draw" | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [device, setDevice] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // 0 = the file as it is now; N = its saved version N (live reload pauses).
  const [version, setVersion] = useState(0);
  const [manual, setManual] = useState(0);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // The mounted frame element: Board ↔ page, Compare and the first page each mount a new one, which must get its address.
  const [frameEl, setFrameEl] = useState<HTMLIFrameElement | null>(null);
  const frameMount = useCallback((el: HTMLIFrameElement | null) => {
    frameRef.current = el;
    setFrameEl(el);
  }, []);
  const boxRef = useRef<HTMLDivElement>(null);
  const scroll = useRef({ x: 0, y: 0 });
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<DesignExportFormat | null>(null);
  const [exported, setExported] = useState<{ path: string } | { error: string } | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  // The page asked for (null = the entry file), the side-by-side view, and the last promote's outcome.
  const [page, setPage] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [board, setBoard] = useState(false);
  const [flow, setFlow] = useState(false);
  // The inspector: the selected element's properties and the page's code, beside the stage.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // The page's layer tree for the inspector's Elements tab, as its bridge last reported it.
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  // The page the Present overlay starts on (null = not presenting).
  const [present, setPresent] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);
  // `page` ties a notice to the page it's about: switching to another page drops it.
  const [notice, setNotice] = useState<{ text: string; error?: boolean; page?: string } | null>(null);
  // The page's declared tweaks with the values it loaded with, and the user's unkept changes per page.
  const [tweaks, setTweaks] = useState<{ list: Tweak[]; base: TweakValues } | null>(null);
  const [overrides, setOverrides] = useState<Record<string, TweakValues>>({});
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [keeping, setKeeping] = useState(false);
  // The canvas selection lives in the store (the composer shows it as chips); the frame draws it.
  const selection = useStore((s) => s.designSelection[threadId]);
  // The thread's prototype tier decides which canvas tools show.
  const tier = useStore((s) => {
    for (const list of Object.values(s.threads)) {
      const t = list.find((x) => x.id === threadId);
      if (t) return tierOf(t);
    }
    return DEFAULT_TIER;
  });
  const features = tierFeatures(tier);
  // Comments (Real app tier): kept in the design folder; this page's open ones are pinned in the frame.
  const [comments, setComments] = useState<DesignComment[]>([]);
  const [pinMissing, setPinMissing] = useState<number[]>([]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState<string | null>(null);
  const [sendingComments, setSendingComments] = useState(false);
  const agentRunning = useStore((s) => Boolean(s.running[threadId]));
  const pinsRef = useRef<{ n: number; target: DesignComment["target"] }[]>([]);
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
    setTool(null);
    setStrokes([]);
    setDevice(false);
    setExported(null);
    setPage(null);
    setCompare(false);
    setBoard(false);
    setFlow(false);
    setInspectorOpen(false);
    setPresent(null);
    setNotice(null);
    setTweaks(null);
    setOverrides({});
    setTweaksOpen(false);
    setCommentsOpen(false);
    setCommentDraft(null);
    setPinMissing([]);
    scroll.current = { x: 0, y: 0 };
  }, [threadId]);

  // The thread's comments, read again whenever its folder changes.
  useEffect(() => {
    let live = true;
    void api()
      .designComments(threadId)
      .then((list) => live && setComments(list))
      .catch(() => live && setComments([]));
    return () => {
      live = false;
    };
  }, [threadId, reload]);

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

  // The stage is measured from whichever element is mounted: it remounts on Board, Compare and the first page, and
  // a stale observer on a detached one would leave sized viewports scaled to nothing.
  const stageObserver = useRef<ResizeObserver | null>(null);
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    stageObserver.current?.disconnect();
    stageObserver.current = null;
    if (!el) return;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    stageObserver.current = new ResizeObserver(measure);
    stageObserver.current.observe(el);
  }, []);

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
        if (picking) post({ type: "pick", on: true, edit: features.textEdit });
        if (pinsRef.current.length) post({ type: "set-pins", pins: pinsRef.current });
        if (deviceRef.current) post({ type: "device-chrome", on: true });
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
      } else if (msg.type === "text-edit") {
        // An in-place edit: written into the file only when it's unambiguous; otherwise the page goes back to the file.
        if (!entry || version !== 0) return;
        const rel = entry.rel;
        void api()
          .designEditText(threadId, rel, { id: msg.id, before: msg.before, after: msg.after })
          .catch((err: unknown) => {
            setNotice({ text: ipcError(err), error: true });
            setManual((n) => n + 1);
          });
      } else if (msg.type === "pins") {
        setPinMissing(msg.missing);
      } else if (msg.type === "outline") {
        setOutline(msg.nodes);
      } else if (msg.type === "edit-refused") {
        setNotice({ text: msg.reason });
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
  }, [entry, picking, post, threadId, version, setSelection, features.textEdit]);

  // Opening the inspector asks for a fresh outline: a page that renders with script has more layers than at load.
  useEffect(() => {
    if (inspectorOpen) post({ type: "outline" });
  }, [inspectorOpen, post]);

  // A tier switch while selecting turns in-place editing on or off right away.
  useEffect(() => {
    if (picking) post({ type: "pick", on: true, edit: features.textEdit });
  }, [features.textEdit]);

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
    setTool(on ? "select" : null);
    if (on) setStrokes([]);
    post({ type: "pick", on, edit: features.textEdit });
  };

  // The floating bar's tool: Select picks like the header button; Text edit and Comment pick with the edit flag set
  // to what the tier allows; Draw puts the pen down. Choosing the current tool again turns everything off.
  const chooseTool = (t: "select" | "text" | "comment" | "draw") => {
    if (t === tool) {
      setTool(null);
      setStrokes([]);
      if (picking) {
        setPicking(false);
        post({ type: "pick", on: false });
      }
      return;
    }
    if (t === "select") {
      setPicking(true);
      post({ type: "pick", on: true, edit: features.textEdit });
    } else if (t === "text") {
      setPicking(true);
      post({ type: "pick", on: true, edit: true });
    } else if (t === "comment") {
      setPicking(true);
      post({ type: "pick", on: true, edit: false });
    } else if (picking) {
      setPicking(false);
      post({ type: "pick", on: false });
    }
    if (t === "draw") setStrokes([]);
    setTool(t);
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
      setTool(null);
      post({ type: "pick", on: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking, post, threadId]);

  // Comment tool: picking one element opens the existing comment form (the chips already go with the message).
  // Only a new pick opens it, so Cancel closes it until the next one.
  const pickedOne = selected.length === 1 ? selected[0]!.selector : null;
  useEffect(() => {
    if (tool === "comment" && pickedOne && features.comments) setCommentDraft((draft) => draft ?? "");
  }, [tool, pickedOne, features.comments]);

  const path = entry ? `${entry.dir}/${entry.rel}` : null;
  const versions = (files?.find((f) => f.path === path)?.versions ?? []).slice().sort((a, b) => b.version - a.version);
  const src = entry ? (version ? `${entry.url}?v=${version}` : entry.url) : null;
  // The latest file remounts on every change; a saved version stays put.
  const frameKey = version ? `v${version}` : `live-${reload}-${manual}`;
  // A device frame hides the page's scrollbars (a reload asks again on ready).
  const deviceRef = useRef(false);
  const deviceOn = device && deviceFor(viewport) !== null;
  useEffect(() => {
    deviceRef.current = deviceOn;
    post({ type: "device-chrome", on: deviceOn });
  }, [deviceOn, post]);

  // The device chrome (bezel, browser bar) takes room the frame can't use when it fits to the stage.
  const chrome = device ? DEVICE_CHROME[deviceFor(viewport) ?? "none"] : DEVICE_CHROME.none;
  const layout = frameLayout(viewport, zoom, { width: stage.width - chrome.width, height: stage.height - chrome.height }, device && deviceFor(viewport) !== null);
  const fit = viewport === "fit";
  // The device chrome to draw: only when toggled on and the viewport has a device (not Fit or Slide).
  const kind = device ? deviceFor(viewport) : null;
  // Exports lay the page out at the viewport on screen; Fit exports at desktop width.
  const exportWidth = VIEWPORTS.find((v) => v.value === viewport)?.size?.width ?? 1440;

  // The frame's address is set by hand, so a page the frame reached by a link isn't loaded again when the canvas
  // follows it (a remount is a new frame, so it always loads).
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !src || frame.dataset.src === src) return;
    frame.dataset.src = src;
    frame.src = src;
  }, [src, frameKey, comparing, frameEl]);

  const pageComments = features.comments && entry ? comments.filter((c) => c.page === entry.rel && !c.resolved) : [];
  const pins = version === 0 && !comparing ? pageComments.map((c, i) => ({ n: i + 1, target: c.target })) : [];
  const pinsKey = JSON.stringify(pins);
  // Pins follow the comments (and go away outside the Real app tier); a reload gets them again on ready.
  useEffect(() => {
    pinsRef.current = JSON.parse(pinsKey) as typeof pins;
    post({ type: "set-pins", pins: pinsRef.current });
    if (!pinsRef.current.length) setPinMissing([]);
  }, [pinsKey, post]);

  const addComment = async () => {
    const el = selected[0];
    const text = commentDraft?.trim() ?? "";
    if (!entry || !el || !text) return;
    try {
      setComments(await api().designCommentAdd(threadId, { page: entry.rel, target: { id: el.id, selector: el.selector, tag: el.tag, text: el.text }, label: elementLabel(el), text }));
      setCommentDraft(null);
    } catch (err) {
      setNotice({ text: `Couldn't add the comment: ${ipcError(err)}`, error: true });
    }
  };
  const changeComment = async (run: () => Promise<DesignComment[]>) => {
    try {
      setComments(await run());
    } catch (err) {
      setNotice({ text: ipcError(err), error: true });
    }
  };
  // The unsent comments go out as one message; they stay open (pinned) until resolved.
  const sendComments = async () => {
    if (!entry) return;
    const unsent = pageComments.filter((c) => !c.sentAt);
    if (!unsent.length) return;
    setSendingComments(true);
    try {
      const ok = await useStore.getState().send(commentsMessage(`${entry.dir}/${entry.rel}`, unsent), undefined, threadId);
      if (!ok) return;
      let list = comments;
      for (const c of unsent) list = await api().designCommentUpdate(threadId, c.id, { sent: true });
      setComments(list);
      setCommentsOpen(false);
    } catch (err) {
      setNotice({ text: `Couldn't send the comments: ${ipcError(err)}`, error: true });
    } finally {
      setSendingComments(false);
    }
  };

  // Real app tier: hand the design to a chat thread that builds it in the codebase (writing the handoff first).
  const hasHandoff = !!entry?.handoff;
  const buildInCode = async () => {
    if (hasHandoff) {
      // The "handoff first" notice is done with; the store's own toast confirms the build.
      setNotice(null);
      return void useStore.getState().buildDesignInCode(threadId);
    }
    const ok = await useStore.getState().send("Write the developer handoff for this design.", ["design-handoff"], threadId);
    if (ok) setNotice({ text: "Writing the handoff first. Choose Build in code again once handoff.md is there." });
  };

  const rel = entry?.rel ?? null;
  useEffect(() => {
    setNotice((n) => (n?.page && n.page !== rel ? null : n));
  }, [rel]);
  const pageOverrides = (rel && overrides[rel]) || {};
  const tweakValues: TweakValues = tweaks ? { ...tweaks.base, ...pageOverrides } : {};
  const tweakChanges = tweaks ? changedTweaks(tweaks.base, pageOverrides) : {};
  const tweaksDirty = Object.keys(tweakChanges).length > 0;
  const showTweaks = features.tweaks && !!tweaks && !!entry && version === 0 && !comparing;

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
      await api().designKeepTweaks(threadId, rel, tweakChanges);
      setOverrides((o) => {
        const next = { ...o };
        delete next[rel];
        return next;
      });
      setTweaksOpen(false);
      setNotice({ text: `Kept the tweaks in ${rel}. The previous page is saved as a version.`, page: rel });
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

  // Restore: version N becomes the newest version (the page as it is now is kept as one), then the canvas shows it live.
  const restore = async (rel: string, v: number) => {
    setRestoring(true);
    try {
      await api().designRestoreVersion(threadId, rel, v);
      setVersion(0);
      setNotice({ text: `Restored v${v} as the latest version.` });
    } catch (err) {
      setNotice({ text: ipcError(err), error: true });
    } finally {
      setRestoring(false);
    }
  };

  // Attach: the floating bar steps aside, then the frame box (the page plus the drawing over it) is captured and put
  // into the composer as a reference image for the next message.
  const attach = async () => {
    setCapturing(true);
    try {
      // Wait a frame so the bar is gone and the overlay has repainted before the area is read.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const box = boxRef.current;
      if (!box) return;
      const r = box.getBoundingClientRect();
      const res = await api().designCapture(threadId, { x: r.left, y: r.top, width: r.width, height: r.height });
      useStore.getState().addDesignRefs(threadId, [res]);
      setStrokes([]);
      setTool(null);
      setNotice({ text: "Drawing attached to your next message." });
    } catch (err) {
      setNotice({ text: ipcError(err), error: true });
    } finally {
      setCapturing(false);
    }
  };

  // The frame itself; with a device on it sits in that device's shell (sized to the screen, so capture and picking are unchanged).
  const frameBox = entry && src ? (
    <div
      className="design-frame-box"
      ref={boxRef}
      style={fit ? undefined : { width: layout.width * layout.scale, height: layout.height * layout.scale }}
    >
      <iframe
        key={frameKey}
        ref={frameMount}
        className="design-frame"
        title={`Design: ${entry.rel}`}
        sandbox="allow-scripts"
        style={fit ? undefined : { width: layout.width, height: layout.height, transform: `scale(${layout.scale})` }}
      />
      {grid && <div className="design-grid" style={{ backgroundSize: `${8 * layout.scale}px ${8 * layout.scale}px` }} aria-hidden />}
      {tool === "draw" && <DrawOverlay strokes={strokes} onStrokes={setStrokes} />}
    </div>
  ) : null;

  const stageEl = entry && src ? (
    <div className={`design-stage${fit ? " fit" : ""}${kind ? ` device-${kind}` : ""}`} ref={stageRef}>
      {/* The shell is always mounted (display: contents without a device), so toggling it never reloads the frame. */}
      <div className={kind ? `device-shell device-${kind}` : "device-off"} style={kind ? ({ "--s": layout.scale } as CSSProperties) : undefined}>
        {kind === "browser" && (
          <div className="device-browserbar" aria-hidden>
            <span className="device-dots" />
            <span className="device-address">{entry.rel}</span>
            <span className="device-spacer" />
          </div>
        )}
        <div className={kind ? "device-screen" : "device-off"}>
          {frameBox}
          {kind === "phone" && <div className="device-island" aria-hidden />}
          {kind && kind !== "browser" && <div className="device-homebar" aria-hidden />}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <section className="design-canvas" aria-label="Design canvas">
      <header className="design-canvas-head drag">
        {board && entry && version === 0 ? (
          <span className="design-canvas-title">Board · {entry.pages.length} pages</span>
        ) : entry && options.length > 1 && !comparing ? (
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
          {entry && entry.pages.length > 1 && version === 0 && (
            <button
              className={`icon-button${board ? " active" : ""}`}
              aria-pressed={board}
              title={board ? "Back to one page" : "Board: see every page"}
              aria-label="Board view"
              onClick={() => {
                if (!board && picking) {
                  setPicking(false);
                  post({ type: "pick", on: false });
                }
                if (!board) setCompare(false);
                setBoard(!board);
              }}
            >
              <LayoutGrid size={16} strokeWidth={1.75} aria-hidden />
            </button>
          )}
          {board && entry && version === 0 && (
            <>
              <button
                className={`icon-button${flow ? " active" : ""}`}
                aria-pressed={flow}
                aria-label="Show flow arrows"
                title="Flow: arrows between linked screens"
                onClick={() => setFlow(!flow)}
              >
                <Workflow size={16} strokeWidth={1.75} aria-hidden />
              </button>
              <button
                className="icon-button"
                aria-label="Present"
                title="Present from the first screen"
                onClick={() => {
                  const first = flowOrder(entry.pages)[0];
                  if (first) setPresent(first);
                }}
              >
                <Play size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </>
          )}
          {!board && (
            <Select<Viewport> value={viewport} options={VIEWPORTS.map(({ value, label, detail }) => ({ value, label, detail }))} onChange={setViewport} ariaLabel="Viewport" className="ghost-select" />
          )}
          <button
            className={`icon-button${device ? " active" : ""}`}
            aria-label="Device frame"
            title="Show a device frame"
            aria-pressed={device}
            disabled={deviceFor(viewport) === null || board || comparing}
            onClick={() => setDevice(!device)}
          >
            <Smartphone size={16} strokeWidth={1.75} aria-hidden />
          </button>
          {!board && !fit && <Select<Zoom> value={zoom} options={ZOOMS} onChange={setZoom} ariaLabel="Zoom" className="ghost-select" />}
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
          {showTweaks && !inspectorOpen && (
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
          {features.comments && entry && version === 0 && !comparing && (
            <CommentsPanel
              comments={pageComments}
              missing={pinMissing}
              open={commentsOpen}
              busy={agentRunning || sendingComments}
              onOpen={setCommentsOpen}
              onResolve={(c) => void changeComment(() => api().designCommentUpdate(threadId, c.id, { resolved: true }))}
              onDelete={(c) => void changeComment(() => api().designCommentDelete(threadId, c.id))}
              onSend={() => void sendComments()}
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
          {entry && version === 0 && !board && !comparing && (
            <button
              className={`icon-button${inspectorOpen ? " active" : ""}`}
              aria-label="Inspector"
              title="Inspector: properties and code"
              aria-pressed={inspectorOpen}
              onClick={() => {
                if (!inspectorOpen && !picking) togglePick();
                setInspectorOpen(!inspectorOpen);
              }}
            >
              <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden />
            </button>
          )}
          <button
            className={`icon-button${picking ? " active" : ""}`}
            title={picking ? `Selecting: click an element, Shift-click for more, ${features.textEdit ? "double-click text to edit it " : ""}(Esc clears, then stops)` : "Select elements to change"}
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
          {tier === "real-app" && entry && (
            <button
              className="icon-button"
              title={hasHandoff ? "Build in code: a chat thread implements this design in the codebase" : "Build in code: write the developer handoff first"}
              aria-label="Build in code"
              disabled={agentRunning}
              onClick={() => void buildInCode()}
            >
              <Hammer size={16} strokeWidth={1.75} aria-hidden />
            </button>
          )}
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
          {features.comments && selected.length === 1 && commentDraft === null && (
            <button className="button ghost" onClick={() => setCommentDraft("")}>
              Comment
            </button>
          )}
          <button className="button ghost" onClick={clearSelection}>
            Clear
          </button>
        </nav>
      )}
      {commentDraft !== null && selected.length === 1 && !comparing && version === 0 && (
        <form
          className="design-comment-new"
          onSubmit={(e) => {
            e.preventDefault();
            void addComment();
          }}
        >
          <input
            autoFocus
            className="design-comment-input"
            aria-label={`Comment on ${elementLabel(selected[0]!)}`}
            placeholder={`Comment on ${elementLabel(selected[0]!)}`}
            value={commentDraft}
            maxLength={1000}
            onChange={(e) => setCommentDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setCommentDraft(null);
              }
            }}
          />
          <button type="submit" className="button" disabled={!commentDraft.trim()}>
            Add
          </button>
          <button type="button" className="button ghost" onClick={() => setCommentDraft(null)}>
            Cancel
          </button>
        </form>
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
          {entry && (
            <button className="button ghost" disabled={restoring} onClick={() => void restore(entry.rel, version)}>
              Restore this version
            </button>
          )}
          <button className="button ghost" onClick={() => setVersion(0)}>
            Back to latest
          </button>
        </div>
      )}
      {board && entry && version === 0 ? (
        <Board
          pages={entry.pages}
          links={entry.links}
          flow={flow}
          reloadKey={`${reload}-${manual}`}
          onFocus={(rel) => {
            setBoard(false);
            scroll.current = { x: 0, y: 0 };
            setPage(rel);
          }}
          onPresent={setPresent}
        />
      ) : comparing ? (
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
        // One wrapper either way, so opening the inspector never remounts (and reloads) the frame.
        <div className="design-stage-row">
          {/* One wrapper around the stage (and the floating tools), so the inspector never remounts the frame. */}
          <div className="design-stage-wrap">
            {stageEl}
            {entry && src && version === 0 && !board && !comparing && !capturing && (
              <div className="design-float-tools" role="toolbar" aria-label="Canvas tools">
                <button
                  className={`icon-button${tool === "select" ? " active" : ""}`}
                  aria-pressed={tool === "select"}
                  aria-label="Select"
                  title="Select elements to change"
                  onClick={() => chooseTool("select")}
                >
                  <MousePointer2 size={16} strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  className={`icon-button${tool === "text" ? " active" : ""}`}
                  aria-pressed={tool === "text"}
                  aria-label="Edit text"
                  title={features.textEdit ? "Click text to edit it in place" : "Text editing needs the Working or Real app tier"}
                  disabled={!features.textEdit}
                  onClick={() => chooseTool("text")}
                >
                  <Type size={16} strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  className={`icon-button${tool === "comment" ? " active" : ""}`}
                  aria-pressed={tool === "comment"}
                  aria-label="Comment"
                  title={features.comments ? "Comment on an element" : "Comments need the Real app tier"}
                  disabled={!features.comments}
                  onClick={() => chooseTool("comment")}
                >
                  <MessageSquarePlus size={16} strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  className={`icon-button${tool === "draw" ? " active" : ""}`}
                  aria-pressed={tool === "draw"}
                  aria-label="Draw on the design"
                  title="Draw on the design"
                  onClick={() => chooseTool("draw")}
                >
                  <Pencil size={16} strokeWidth={1.75} aria-hidden />
                </button>
                {tool === "draw" && (
                  <>
                    <span className="design-float-divider" aria-hidden />
                    <button
                      className="icon-button"
                      aria-label="Undo stroke"
                      title="Undo the last stroke"
                      disabled={strokes.length === 0}
                      onClick={() => setStrokes(strokes.slice(0, -1))}
                    >
                      <Undo2 size={16} strokeWidth={1.75} aria-hidden />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Clear drawing"
                      title="Clear the drawing"
                      disabled={strokes.length === 0}
                      onClick={() => setStrokes([])}
                    >
                      <Eraser size={16} strokeWidth={1.75} aria-hidden />
                    </button>
                    <button className="button primary" disabled={strokes.length === 0 || capturing} onClick={() => void attach()}>
                      Attach
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {inspectorOpen && (
            <InspectorPanel
              threadId={threadId}
              element={selected[0] ?? null}
              pageRel={entry.rel}
              designDir={entry.dir}
              reloadKey={`${reload}-${manual}`}
              onPreview={(prop, value) => {
                const el = selected[0];
                if (!el) return;
                post({
                  type: "preview-style",
                  target: { ...(el.id ? { id: el.id } : {}), selector: el.selector, tag: el.tag, text: el.text },
                  prop,
                  value,
                });
              }}
              onClearPreview={() => post({ type: "clear-preview" })}
              writes={features.textEdit && Boolean(selected[0]?.id)}
              onApply={(changes) => {
                post({ type: "clear-preview" });
                const draft = () =>
                  useStore.getState().setComposerDraft("Change the selected element: " + changes.map((c) => `${kebab(c.prop)} ${c.from} → ${c.to}`).join("; ") + ".");
                const id = selected[0]?.id;
                // Working and Real app write the styles straight into the page; Quick (or an element with no id) asks the agent.
                if (!features.textEdit || !id) return draft();
                void api()
                  .designEditStyle(threadId, entry.rel, { id, changes: changes.map((c) => ({ prop: c.prop, value: c.to })) })
                  .catch((err) => {
                    setNotice({ text: `${ipcError(err)} The change is in the composer instead.`, error: true });
                    draft();
                  });
              }}
              elements={
                <ElementsTree
                  nodes={outline}
                  selected={selected[0] ?? null}
                  onPick={(n) => post({ type: "set-selection", targets: [{ ...(n.id ? { id: n.id } : {}), selector: n.selector, tag: n.tag, text: "" }] })}
                />
              }
              tweaks={
                showTweaks ? (
                  <div className="design-tweaks">
                    <TweaksBody
                      tweaks={tweaks.list}
                      values={tweakValues}
                      dirty={tweaksDirty}
                      keeping={keeping}
                      onChange={changeTweak}
                      onReset={resetTweaks}
                      onKeep={() => void keepTweaks()}
                    />
                  </div>
                ) : null
              }
            />
          )}
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
      {present && entry && <Present pages={entry.pages} links={entry.links} start={present} onExit={() => setPresent(null)} />}
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
