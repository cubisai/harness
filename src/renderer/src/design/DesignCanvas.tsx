import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal, flushSync } from "react-dom";
import { LayoutGrid, Play } from "lucide-react";
import type { DesignDetect, DesignEntry, DesignExportFormat, DesignKitGroup } from "../../../shared/types";
import { api } from "../api";
import { fileManagerName } from "../components/OpenIn";
import { Select } from "../components/Select";
import { IconClose } from "../icons";
import "../styles/artifact.css";
import { affectedPages, useStore } from "../store";
import { designStyleName, useDesignSystemOptions } from "../components/DesignSystemMenu";
import { chipLabel, referenceName } from "../components/StylePicker";
import { STYLE_PREFIX, readDirection } from "../../../shared/direction";
import { STAGE_PAD, VIEWPORTS, ZOOMS, createBridgeGate, deviceFor, frameLayout, pageFromPath, readBridgeMessage, viewportForDevice, type FrameAnchor, type FrameRect, type OutlineNode, type PageSeam, type VariantSetInfo, type Viewport, type Zoom } from "./frame";
import { announceSelection, contextBlock, elementLabel, selectionKey, withScope, type SelectedElement } from "../../../shared/selection";
import { withRefs } from "./refs";
import { VariantCycler, cycleStep, escClears, goMessage, insertMessage, placeFloatingBar, type ActionId } from "./variants";
import { compareCells, pageOptions, sameEntry, type CompareCell } from "./pages";
import { changedTweaks, currentTweakValues, parseTweaks, tweakTarget, tweakValue, type Tweak, type TweakValues } from "../../../shared/tweaks";
import { TweaksBody } from "./TweaksPanel";
import { ElementsTree } from "./ElementsTree";
import { parentName } from "./layers";
import { DEFAULT_TIER, tierFeatures, tierOf } from "../../../shared/tiers";
import { commentsMessage, type DesignComment } from "../../../shared/comments";
import { CommentsPanel } from "./CommentsPanel";
import { boardSections, flowOrder, frameLabel, type BoardPage } from "./board-layout";
import { Board } from "./Board";
import { Present } from "./Present";
import { CustomizePanel, THEME_TOKENS } from "./CustomizePanel";
import { RETAG_TAGS, type InsertPosition } from "../../../shared/design-mutation";
import { optionLabel, scaleChanges, scaleStepOf, textVariantProp, tokenNames, typeScale, inlineStyle } from "./text-styles";
import { useDesignEditing } from "./useDesignEditing";
import { StudioBar, viewportMenu, type StudioMenuItem, type StudioView } from "./StudioBar";
import { CodeView } from "./CodeView";
import { SystemMode } from "./SystemMode";
import { MOD_KEY } from "./system-mode";
import { ActionsMenu, MORE_DIRECTIONS, SeamButton, SeamPalette, SelectionChrome, SwapPopover, VARIANT_DIRECTIONS, type ActionItem, type SeamPosition } from "./SelectionChrome";
import { CanvasToolsPill, DrawLayer, drawMessage, strokeBounds, toolForKey, type CanvasTool, type Stroke } from "./CanvasTools";
import { NamePrompt } from "./NamePrompt";
import { textHash } from "../../../shared/text-hash";
import { blockFile, instanceOf, jsxOf, lineOf, parseKitParts, rootTokens, startAttrs, swapNotice, swapPlan, wrapAttrs, wrapShapes, type AttrChange, type KitPart, type WrapShape } from "./kit-parts";

const ipcError = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

/**
 * A design thread's canvas: the agent's page in a sandboxed frame (scripts on, no network, no app access), reloaded
 * as its folder changes, with viewport, zoom, an 8px grid, saved versions and pick-to-comment. Loaded only when a
 * design thread opens, so the Chat bundle stays as it was.
 */
/** How far the header folds when its tools don't fit: 1 = grid, reload and folder into More; 2 = the pickers to a second row. */
const MAX_FOLD = 2;

/** The skill every Go turn carries: how to write the three variants in place. */
const VARIANTS_SKILL = "design-variants";

/** The outline while the current page hasn't reported its own: one stable empty list. */
const NO_NODES: OutlineNode[] = [];

/** Extra room the device chrome needs around a frame (both sides together, in stage px, beyond the usual padding). */
const DEVICE_CHROME = { none: { width: 0, height: 0 }, phone: { width: 40, height: 40 }, tablet: { width: 56, height: 56 }, browser: { width: 18, height: 54 } } as const;

/** How long a structural edit's report stays up. */
const TOAST_MS = 6000;

/** What the kit calls an element (`StatCard`), else its part (`Card · header`), else its tag and text. */
export function partLabel(el: SelectedElement, parts: readonly KitPart[]): string {
  const attrs = startAttrs(el.html);
  const part = parts.find((p) => p.ui === attrs["data-ui"]);
  return part?.name ?? (attrs["data-part"] ? parentName({ label: "", part: attrs["data-part"] }) : elementLabel(el));
}

export default function DesignCanvas({
  threadId,
  canvasFirst = false,
  headSlot = null,
}: {
  threadId: string;
  /** The canvas fills the main area (the chat is a prompt bar over it): the Pages and Layers rail and the vertical tools. */
  canvasFirst?: boolean;
  /** Canvas-first: the main header's slot this canvas's header goes into, so the window has one top bar. */
  headSlot?: HTMLElement | null;
}) {
  const reload = useStore((s) => s.designReload[threadId] ?? 0);
  const change = useStore((s) => s.designChange[threadId]);
  const files = useStore((s) => s.artifactFiles[threadId]);
  const [entry, setEntry] = useState<DesignEntry | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The viewport the user picked (null = none yet: the page's declared device decides, see viewportForDevice).
  const [viewportPick, setViewport] = useState<Viewport | null>(null);
  // Design v2's direct editing (a build switch until it replaces the old flow).
  const viewport = viewportPick ?? viewportForDevice(entry?.pages.find((p) => p.rel === entry.rel)?.device);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [grid, setGrid] = useState(false);
  const [picking, setPicking] = useState(false);
  // The device frame around the page.
  const [device, setDevice] = useState(false);
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
  // Board by default: the first time a thread's design has several pages it opens on the board, unless the view was
  // already chosen by hand. `entryThread` says which thread the shown entry belongs to (it lags a thread switch).
  const autoBoard = useRef({ thread: threadId, done: false });
  const entryThread = useRef<string | null>(null);
  const chooseBoard = (on: boolean) => {
    autoBoard.current.done = true;
    setBoard(on);
  };
  const [flow, setFlow] = useState(false);
  // The inspector: the selected element's properties and the page's code, beside the stage.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // Where the picked element is in the frame: the selection's name tag and handles sit on it.
  const [anchor, setAnchor] = useState<FrameAnchor | null>(null);
  // In-place variant sets the agent wrote on this page, the shown variant's box, and an Accept or × on its way.
  const [variantSets, setVariantSets] = useState<VariantSetInfo[]>([]);
  const [variantRect, setVariantRect] = useState<{ set: string; rect: FrameRect | null } | null>(null);
  const [cyclerSize, setCyclerSize] = useState({ width: 0, height: 0 });
  const [resolving, setResolving] = useState(false);
  const variantsRef = useRef(false);
  variantsRef.current = variantSets.length > 0;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stageNode = useRef<HTMLDivElement | null>(null);
  const [, setStageScrolled] = useState(0);
  // The page's layer tree for the inspector's Elements tab, as its bridge last reported it.
  // Tagged with the page it came from: after a page or thread switch the old outline isn't shown as the new page's.
  const [pageOutline, setPageOutline] = useState<{ path: string; nodes: OutlineNode[] } | null>(null);
  // The page the Present overlay starts on (null = not presenting).
  const [present, setPresent] = useState<string | null>(null);
  const [promoting, setPromoting] = useState<string | null>(null);
  // `page` ties a notice to the page it's about: switching to another page drops it.
  const [notice, setNotice] = useState<{ text: string; error?: boolean; page?: string } | null>(null);
  // A report on a structural edit: it floats, so the page doesn't move under the pointer, and doesn't outlast its use.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);
  // The page's declared tweaks with the values it loaded with, and the user's unkept changes per page.
  const [tweaks, setTweaks] = useState<{ list: Tweak[]; base: TweakValues } | null>(null);
  const [overrides, setOverrides] = useState<Record<string, TweakValues>>({});
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
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
  // In v2 tiers only change how much the agent builds: direct edits work on all of them.
  const tierHas = tierFeatures(tier);
  const features = { ...tierHas, textEdit: true, tweaks: true, comments: true };
  // The style the design is drawn in names the board's artboards (`Page · Style`, `Option · <its style>`).
  const thread = useStore((s) => {
    for (const list of Object.values(s.threads)) {
      const t = list.find((x) => x.id === threadId);
      if (t) return t;
    }
    return null;
  });
  const systemOptions = useDesignSystemOptions(thread?.projectId ?? null, false, thread?.designSystem);
  // On v2 the name comes from the kit lists, which know a kit's themes as today's list doesn't.
  const [kitGroups, setKitGroups] = useState<DesignKitGroup[]>([]);
  useEffect(() => {
    let live = true;
    void api()
      .designKitGroups(thread?.projectId ?? null)
      .then((list) => live && setKitGroups(list))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [thread?.projectId, thread?.designSystem]);
  // A reference-built thread says where its look came from; re-read when the system or the page reloads.
  const [styleNote, setStyleNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api()
      .designReferenceNote(threadId)
      .then((note) => live && setStyleNote(note))
      .catch(() => live && setStyleNote(null));
    return () => {
      live = false;
    };
  }, [threadId, thread?.designSystem, thread?.designDirection?.reference?.sha256, reload]);
  const styleName = kitGroups.length ? chipLabel(kitGroups, thread?.designSystem, readDirection(thread?.designDirection) ?? null).name : designStyleName(systemOptions, thread?.designSystem, readDirection(thread?.designDirection));
  // A "More styles" option's own look: a reference by slug, or a kit theme by its folder (`kit:mui/indigo` -> mui-indigo).
  const styleOf = useCallback(
    (slug: string) => {
      const ref = referenceName(slug);
      if (ref) return ref;
      for (const g of kitGroups) {
        const theme = g.themes.find((t) => !t.mine && t.id.replace(/^kit:/, "").replace(/\//g, "-") === slug);
        if (theme) return theme.name === g.name ? g.name : `${g.name} · ${theme.name}`;
      }
      return systemOptions.find((o) => o.id === STYLE_PREFIX + slug)?.name;
    },
    [kitGroups, systemOptions],
  );
  const labelOf = useCallback((p: BoardPage) => frameLabel(p, styleName, styleOf), [styleName, styleOf]);
  // Canvas-first's Pages and Layers rail, open or not (kept in the pane layout).
  // The top bar's view (v2). Preview, Code and System take the whole width: the side panels come back with Design.
  const [viewState, setViewState] = useState<StudioView>("design");
  const view: StudioView = viewState;
  // Below 1000px the rail folds for now, without changing what's saved: widening the window brings it back.
  const [railFolded, setRailFolded] = useState(false);
  const railSaved = useStore((s) => s.paneLayout.designRail);
  const railWanted = canvasFirst && railSaved && !railFolded;
  const railOpen = railWanted && view === "design" && Boolean(entry);
  const setPaneLayout = useStore((s) => s.setPaneLayout);
  // Comments (Real app tier): kept in the design folder; this page's open ones are pinned in the frame.
  const [comments, setComments] = useState<DesignComment[]>([]);
  const [pinMissing, setPinMissing] = useState<number[]>([]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState<string | null>(null);
  const [sendingComments, setSendingComments] = useState(false);
  const agentRunning = useStore((s) => Boolean(s.running[threadId]));
  // Page thumbnails in the rail: one PNG per page, rendered by the main process (empty until it can).
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const pinsRef = useRef<{ n: number; target: DesignComment["target"] }[]>([]);
  // Detect: the open page's lint findings as clickable pins (null = off). A reload of the page runs it again.
  const [detect, setDetect] = useState<DesignDetect | "busy" | null>(null);
  const detectRef = useRef<{ run: number; rel: string | null; result: DesignDetect | null }>({ run: 0, rel: null, result: null });
  const setSelection = useStore((s) => s.setDesignSelection);
  const selected = selection?.elements ?? [];
  const selectedKey = selectionKey(selected);
  // What the frame last reported, so a change made here (a chip's ×) is sent down once and no echo loops back.
  const fromFrame = useRef("");
  const [announcement, setAnnouncement] = useState("");
  const options = entry ? pageOptions(entry.pages) : [];
  const cells = entry ? compareCells(entry.pages) : [];
  const comparing = compare && cells.length > 0 && version === 0;
  // The pages the running turn last wrote wear the beam on the board. Only this turn's writes count: the change
  // counter is noted when the turn starts (derived state, set during render so no frame shows the last turn's).
  const [turnStart, setTurnStart] = useState<number | null>(null);
  if (agentRunning && turnStart === null) setTurnStart(change?.n ?? 0);
  if (!agentRunning && turnStart !== null) setTurnStart(null);
  const written = agentRunning && entry && change && turnStart !== null && change.n > turnStart ? affectedPages(change.paths ?? undefined, entry.pages.map((p) => p.rel)) : [];
  const writingKey = written === "all" ? "" : written.join("\n");
  const writing = useMemo(() => new Set(writingKey ? writingKey.split("\n") : []), [writingKey]);
  // A new thread starts with no thumbnails.
  useEffect(() => {
    setThumbs({});
  }, [threadId]);
  // The rail's page thumbnails: rendered whenever its pages change, unless a turn is writing them.
  useEffect(() => {
    if (!railOpen || !entry || agentRunning) return;
    let cancelled = false;
    for (const p of entry.pages) {
      api()
        .designThumb(threadId, p.rel)
        .then((url) => {
          if (!url || cancelled) return;
          setThumbs((t) => (t[p.rel] === url ? t : { ...t, [p.rel]: url }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [railOpen, threadId, agentRunning, change?.n, entry?.pages.map((p) => p.rel).join("|")]);
  // Watch the folder while the canvas is open; the main process counts watches per window.
  useEffect(() => {
    void api().designWatch(threadId);
    return () => void api().designUnwatch(threadId);
  }, [threadId]);

  // A new thread starts fresh.
  useEffect(() => {
    setVersion(0);
    setPicking(false);
    setAnchor(null);
    detectRef.current = { run: detectRef.current.run + 1, rel: null, result: null };
    setDetect(null);
    setVariantSets([]);
    setVariantRect(null);
    setDevice(false);
    setViewport(null);
    setExported(null);
    setPage(null);
    setCompare(false);
    setBoard(false);
    setFlow(false);
    setInspectorOpen(false);
    setViewState("design");
    setToolState("select");
    setSeam(null);
    setPalette(null);
    setSwapAt(null);
    setActionsAt(null);
    setCodeLine(null);
    pendingSelect.current = null;
    setAppearance(null);
    setPageTheme({});
    setPageScheme(null);
    setPresent(null);
    setNotice(null);
    setTweaks(null);
    setOverrides({});
    setCommentsOpen(false);
    setCommentDraft(null);
    setPinMissing([]);
    scroll.current = { x: 0, y: 0 };
    autoBoard.current = { thread: threadId, done: false };
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
        entryThread.current = threadId;
        setEntry((prev) => (sameEntry(prev, e) ? prev : e));
        setLoaded(true);
      })
      .catch(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [threadId, reload, manual, page]);

  useEffect(() => {
    const auto = autoBoard.current;
    if (auto.done || auto.thread !== threadId || !entry || entryThread.current !== threadId || entry.pages.length < 2) return;
    auto.done = true;
    if (!picking && !compare && version === 0 && !present) setBoard(true);
  }, [entry, threadId, picking, compare, version, present]);

  // The stage is measured from whichever element is mounted: it remounts on Board, Compare and the first page, and
  // a stale observer on a detached one would leave sized viewports scaled to nothing.
  const stageObserver = useRef<ResizeObserver | null>(null);
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    stageObserver.current?.disconnect();
    stageObserver.current = null;
    stageNode.current = el;
    if (!el) return;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    stageObserver.current = new ResizeObserver(measure);
    stageObserver.current.observe(el);
  }, []);

  // The header folds only as far as it must for the tools to fit, never past the canvas into the panel beside it and
  // never by cutting a picker's label: first the grid, reload and folder tools go into More, then the Viewport, Zoom
  // and Version pickers move to a row under the header. Measured (see the layout effect below), so it suits any tool set.
  const [headWidth, setHeadWidth] = useState(0);
  const [fold, setFold] = useState(0);
  const [, setToolsResized] = useState(0);
  const headEl = useRef<HTMLElement | null>(null);
  const toolsEl = useRef<HTMLDivElement | null>(null);
  const foldKey = useRef("");
  const headObserver = useRef<ResizeObserver | null>(null);
  const headRef = useCallback((el: HTMLElement | null) => {
    headObserver.current?.disconnect();
    headObserver.current = null;
    headEl.current = el;
    if (!el) return;
    setHeadWidth(el.clientWidth);
    // flushSync: the fold steps a new width causes land before the browser paints (no frame of spilled tools).
    // The tools are watched too: a picker or panel that loads later changes their width without a re-render here.
    headObserver.current = new ResizeObserver((entries) =>
      flushSync(() => {
        setHeadWidth(el.clientWidth);
        if (entries.some((entry) => entry.target !== el)) setToolsResized((n) => n + 1);
      }),
    );
    headObserver.current.observe(el);
    const tools = el.querySelector(".design-tools");
    if (tools) headObserver.current.observe(tools);
  }, []);
  const pickersBelow = fold >= 2;

  const post = useCallback((msg: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ source: "cubiq-canvas", ...msg }, "*");
  }, []);

  // Direct editing. A frame reload is ours when it follows an undo or a discard, so what it loses isn't news.
  const ownReload = useRef(false);
  // In-place updates (v2): the page text the frame shows, when it's known for sure, so a change to the page is patched
  // into the frame rather than reloading it (a reload flashes, and loses scroll and widget state).
  const frameText = useRef<string | null>(null);
  const patching = useRef<{ n: number; html: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const patchAgain = useRef<{ restyle: boolean } | null>(null);
  const patchSeq = useRef(0);
  const reloadFrame = useCallback(() => {
    ownReload.current = true;
    frameText.current = null;
    patchAgain.current = null;
    if (patching.current) clearTimeout(patching.current.timer);
    patching.current = null;
    setManual((n) => n + 1);
  }, []);
  const sendPatch = useCallback(
    (base: string, html: string, restyle: boolean) => {
      const n = ++patchSeq.current;
      // A frame that never answers (it was navigating away) gets reloaded.
      const timer = setTimeout(() => {
        if (patching.current?.n === n) reloadFrame();
      }, 4000);
      patching.current = { n, html, timer };
      post({ type: "patch", n, base, html, restyle });
    },
    [post, reloadFrame],
  );
  const patchable = version === 0;
  const patchableRef = useRef(patchable);
  patchableRef.current = patchable;
  /** The frame to the page's latest text, from what it shows now; `restyle` also reloads its stylesheets. */
  const refreshFrame = useCallback(
    (restyle: boolean) => {
      if (patching.current) {
        patchAgain.current = { restyle: restyle || patchAgain.current?.restyle === true };
        return;
      }
      const base = frameText.current;
      if (!patchableRef.current || base === null) return reloadFrame();
      editsRef.current.sync((html) => {
        if (frameText.current !== base || patching.current) return refreshFrame(restyle);
        sendPatch(base, html, restyle);
      });
    },
    [reloadFrame, sendPatch],
  );
  const patchFrame = useCallback(
    (base: string, html: string) => {
      if (!patchableRef.current) return reloadFrame();
      // Ours, like a reload after an undo: a selected element it takes away isn't news.
      ownReload.current = true;
      if (patching.current) {
        patchAgain.current = { restyle: patchAgain.current?.restyle === true };
        return;
      }
      sendPatch(base, html, false);
    },
    [reloadFrame, sendPatch],
  );
  const edits = useDesignEditing({
    threadId,
    rel: entry?.rel ?? null,
    on: version === 0,
    onStamp: (at, id) => post({ type: "stamp", path: at, id }),
    reloadFrame,
    patchFrame,
    onText: (html) => {
      if (!patching.current) frameText.current = html;
    },
    notify: (text, error) => setNotice(error ? { text, error } : { text }),
    onHistory: () => setToast(null),
  });
  const editsRef = useRef(edits);
  editsRef.current = edits;
  // Something outside the editor changed the design (the agent, a theme switch): patched in when the frame's text is
  // known, styles loaded again when files other than pages changed, and a reload when a script changed.
  const seenReload = useRef(`${threadId}:${reload}`);
  useEffect(() => {
    const key = `${threadId}:${reload}`;
    const prior = seenReload.current;
    seenReload.current = key;
    if (prior === key || !prior.startsWith(`${threadId}:`) || version !== 0) return;
    const paths = change?.paths ?? null;
    if (paths === null || paths.some((p) => /\.m?js$/i.test(p))) return reloadFrame();
    refreshFrame(paths.some((p) => !/\.html?$/i.test(p)));
    // `change` arrives with `reload`, in the same store update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, reload, version, reloadFrame, refreshFrame]);
  // ⌘Z takes back a theme switch or a kit move while it's the last thing that happened; any later page edit ends that.
  const systemStep = useStore((s) => s.systemStep[threadId]);
  const setSystemStep = useStore((s) => s.setSystemStep);
  const undoStep = useCallback(() => {
    const step = useStore.getState().systemStep[threadId];
    if (!step) return false;
    setSystemStep(threadId, null);
    if (step.undo === "page") editsRef.current.undo();
    else void step.undo().catch((err: unknown) => setNotice({ text: ipcError(err), error: true }));
    return true;
  }, [threadId, setSystemStep]);
  const undoRef = useRef(() => {});
  undoRef.current = () => {
    if (!undoStep()) editsRef.current.undo();
  };
  const [stepShown, setStepShown] = useState(false);
  const revision = edits.status?.revision ?? null;
  const stepRevision = useRef(revision);
  useEffect(() => {
    // System mode's own edits move the page's revision too, and no page edit happens there.
    if (view !== "system" && systemStep && systemStep.undo !== "page" && stepRevision.current !== null && revision !== stepRevision.current) setSystemStep(threadId, null);
    stepRevision.current = revision;
    // Only a page edit made after the step ends it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);
  useEffect(() => {
    if (!systemStep) return;
    const t = setTimeout(() => setStepShown(false), TOAST_MS * 2);
    setStepShown(true);
    return () => clearTimeout(t);
  }, [systemStep]);
  // The page's own overrides of its theme: what `Save as new theme…` keeps.
  const [pageInline, setPageInline] = useState<Record<string, string>>({});
  const pageRelForTokens = entry?.rel ?? null;
  const saveStateForTokens = edits.status?.save ?? null;
  useEffect(() => {
    if (!entry || !pageRelForTokens || saveStateForTokens === "saving") return;
    let live = true;
    void api()
      .readArtifact(threadId, `${entry.dir}/${pageRelForTokens}`)
      .then((res) => live && setPageInline(res.ok ? rootTokens(res.text ?? "") : {}))
      .catch(() => live && setPageInline({}));
    return () => {
      live = false;
    };
    // The page's revision and save state say when it's worth reading again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, entry?.dir, pageRelForTokens, revision, saveStateForTokens, reload]);
  const [naming, setNaming] = useState<{ kind: "theme" | "composition"; warnings: string[]; error: string | null; busy: boolean } | null>(null);
  const gate = useRef(createBridgeGate(() => crypto.randomUUID()));
  // Selecting in the page. In v2 the edit flag follows the turn: a page being written can't be typed into.
  const pickMessage = useCallback(
    (on: boolean): Record<string, unknown> => {
      if (!on) return { type: "pick", on };
      return { type: "pick", on, v2: true, edit: !agentRunning, color: getComputedStyle(document.documentElement).getPropertyValue("--canvas-select").trim() };
    },
    [agentRunning],
  );
  const pickMessageRef = useRef(pickMessage);
  pickMessageRef.current = pickMessage;
  // The page's values for the panel's tokens, and how it's previewed: light or dark, whatever the app's theme.
  const [pageTheme, setPageTheme] = useState<Record<string, string>>({});
  // The page's only scheme, when it has just one: Appearance shows it rather than the app's.
  const [pageScheme, setPageScheme] = useState<"light" | "dark" | null>(null);
  // The kit's colour and type token names, from the page's tokens.css: the panel names colours and type styles by them.
  const [kitTokenNames, setKitTokenNames] = useState<string[]>([]);
  const tokenNamesRef = useRef<string[]>([]);
  tokenNamesRef.current = kitTokenNames;
  const tokensDir = entry?.dir;
  useEffect(() => {
    if (!tokensDir) return setKitTokenNames([]);
    let live = true;
    void api()
      .readArtifact(threadId, `${tokensDir}/system/tokens.css`)
      .then((res) => {
        if (!live) return;
        const names = res.ok && typeof res.text === "string" ? tokenNames(res.text) : [];
        setKitTokenNames((prev) => (prev.join() === names.join() ? prev : names));
        if (names.length) post({ type: "read-theme", names: [...names, ...THEME_TOKENS] });
      })
      .catch(() => live && setKitTokenNames([]));
    return () => {
      live = false;
    };
  }, [threadId, tokensDir, reload, post]);
  const [appearance, setAppearance] = useState<"light" | "dark" | null>(null);
  // The selection Preview set aside, for coming back to Design.
  const heldSelection = useRef<typeof selection>(undefined);
  const [versionPill, setVersionPill] = useState(false);
  // The studio's canvas tools and what they open.
  const [tool, setToolState] = useState<CanvasTool>("select");
  const [seam, setSeam] = useState<PageSeam | null>(null);
  const [palette, setPalette] = useState<{ anchor: SelectedElement; position: SeamPosition; at: { x: number; y: number } } | null>(null);
  const [swapAt, setSwapAt] = useState<{ x: number; y: number } | null>(null);
  const [actionsAt, setActionsAt] = useState<{ x: number; y: number } | null>(null);
  // `Go to component`: the part System view opens on.
  const [systemStart, setSystemStart] = useState<string | null>(null);
  // `Move to…`: what moves, while the next click picks where it goes.
  const [moving, setMoving] = useState<SelectedElement[] | null>(null);
  const [drawCapturing, setDrawCapturing] = useState(false);
  const [codeLine, setCodeLine] = useState<number | null>(null);
  const [kitParts, setKitParts] = useState<KitPart[]>([]);
  // The element a structural edit made or kept, selected once the reloaded frame is ready.
  const pendingSelect = useRef<string | null>(null);
  const hitWaiter = useRef<((el: SelectedElement | null) => void) | null>(null);
  const studioRef = useRef<{ context: (x: number, y: number) => void; key: (key: string, mod: boolean, shift: boolean, alt: boolean) => boolean; toolOf: () => CanvasTool }>({ context: () => {}, key: () => false, toolOf: () => "select" });

  // Only the frame's own window is listened to, and every message is checked (the page is the agent's code).
  useEffect(() => {
    const reselect = (at: string | undefined): void => {
      const sel = useStore.getState().designSelection[threadId];
      if (!sel) ownReload.current = false;
      setSeam(null);
      const made = pendingSelect.current;
      pendingSelect.current = null;
      if (made) {
        fromFrame.current = "";
        post({ type: "set-selection", targets: [{ id: made, selector: `[data-agent-id="${made}"]`, tag: "div", text: "" }] });
      } else if (sel && entry && sel.page === (at ?? entry.rel) && version === 0) {
        fromFrame.current = "";
        post({ type: "set-selection", targets: sel.elements.map(({ id, selector, tag, text }) => ({ id, selector, tag, text })) });
      }
    };
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      if (!gate.current.admit(e.data)) return;
      const msg = readBridgeMessage(e.data);
      if (!msg) return;
      if (msg.type === "ready") {
        // A fresh load: whatever patch was on its way went with the old document.
        if (patching.current) clearTimeout(patching.current.timer);
        patching.current = null;
        patchAgain.current = null;
        frameText.current = null;
        post({ type: "session", nonce: gate.current.renew() });
        post({ type: "read-theme", names: [...tokenNamesRef.current, ...THEME_TOKENS] });
        // The page's text is what the frame shows only if it's the text the frame loaded.
        const loaded = msg.loaded;
        editsRef.current.sync((html) => {
          if (loaded && version === 0 && textHash(html) === loaded && !patching.current) frameText.current = html;
        });
        // A fresh load: its tweaks (if any) arrive right after.
        setTweaks(null);
        setAnchor(null);
        setVariantSets([]);
        setVariantRect(null);
        // A link inside the page went to another page of the design: follow it (title, versions, export) without
        // loading it a second time.
        const at = msg.path ? pageFromPath(msg.path, threadId) : null;
        const to = at && entry && at !== entry.rel && version === 0 ? entry.pages.find((p) => p.rel === at) : undefined;
        if (to) {
          if (frameRef.current) frameRef.current.dataset.src = to.url;
          scroll.current = { x: 0, y: 0 };
          setPage(to.rel);
        } else if (scroll.current.x || scroll.current.y) post({ type: "restore-scroll", ...scroll.current });
        if (picking) post(pickMessageRef.current(true));
        if (pinsRef.current.length) post({ type: "set-pins", pins: pinsRef.current });
        if (!to && entry && detectRef.current.rel === entry.rel) runDetectRef.current(entry.rel, true);
        if (deviceRef.current) post({ type: "device-chrome", on: true });
        // A reload (the agent rewrote the page): find the selection again; anything gone is dropped and reported.
        reselect(to?.rel);
      } else if (msg.type === "patched") {
        const p = patching.current;
        if (!p || msg.n !== p.n) return;
        clearTimeout(p.timer);
        patching.current = null;
        if (!msg.ok) return reloadFrame();
        frameText.current = p.html;
        // The page changed under the selection: find it again, or take what a structural edit made.
        reselect(undefined);
        const again = patchAgain.current;
        patchAgain.current = null;
        if (again) refreshFrame(again.restyle);
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
        setSeam(null);
      } else if (msg.type === "seam") {
        setSeam(msg.seam);
      } else if (msg.type === "context-menu") {
        studioRef.current.context(msg.x, msg.y);
      } else if (msg.type === "canvas-key") {
        studioRef.current.key(msg.key, msg.mod, msg.shift, msg.alt);
      } else if (msg.type === "hit-result") {
        hitWaiter.current?.(msg.element);
      } else if (msg.type === "text-commit") {
        if (version !== 0) return;
        editsRef.current.send(msg.target, { kind: "setText", before: msg.before, after: msg.after }, msg.live ? "text" : null);
      } else if (msg.type === "pointer") {
        if (document.activeElement instanceof HTMLElement && document.activeElement !== frameRef.current) document.activeElement.blur();
      } else if (msg.type === "history-key") {
        if (version === 0) (msg.action === "undo" ? undoRef.current : editsRef.current.redo)();
      } else if (msg.type === "theme") {
        setPageTheme(msg.tokens);
        setPageScheme(msg.scheme ?? null);
      } else if (msg.type === "pins") {
        setPinMissing(msg.missing);
      } else if (msg.type === "outline") {
        if (entry) setPageOutline({ path: `${entry.dir}/${entry.rel}`, nodes: msg.nodes });
      } else if (msg.type === "anchor") {
        setAnchor(msg.anchor);
      } else if (msg.type === "variants") {
        variantsRef.current = msg.sets.length > 0;
        setVariantSets(msg.sets);
        // The picked element is now the hidden original inside the set: the cycler takes over from the element bar.
        if (msg.sets.length && useStore.getState().designSelection[threadId]) setSelection(threadId, null);
      } else if (msg.type === "variant-rect") {
        setVariantRect({ set: msg.set, rect: msg.rect });
      } else if (msg.type === "finding") {
        // A Detect pin picked its element: the Composer gets the finding as a draft.
        const pin = detectRef.current.result?.pins.find((p) => p.n === msg.n);
        if (!pin) return;
        useStore.getState().setComposerDraft(`Fix: ${pin.details.join("; ")}`);
      } else if (msg.type === "edit-refused") {
        setNotice({ text: msg.reason });
      } else if (msg.type === "selection") {
        if (!entry) return;
        fromFrame.current = selectionKey(msg.elements);
        setSelection(threadId, { page: entry.rel, elements: msg.elements });
        setAnnouncement(announceSelection(msg.elements));
        // The Comment tool's click: the note opens on what it took.
        if (studioRef.current.toolOf() === "comment" && msg.elements.length === 1) setCommentDraft("");
        // A variant set on the page means the agent replaced the picked element on purpose: no notice for that.
        const ours = ownReload.current;
        ownReload.current = false;
        if (msg.lost > 0 && !variantsRef.current && !ours)
          setNotice({ text: `${msg.lost === 1 ? "A selected element is" : `${msg.lost} selected elements are`} no longer on the page, so the selection dropped ${msg.lost === 1 ? "it" : "them"}.` });
      } else {
        setPicking(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [entry, picking, post, threadId, version, setSelection, features.textEdit, reloadFrame, refreshFrame]);

  // Opening the inspector or the Layers rail asks for a fresh outline: a page that renders with script has more layers
  // than at load. The rail asks again for each page it shows (the bridge also reports one when a page loads).
  const layersOn = railOpen && !board && !comparing && version === 0;
  useEffect(() => {
    if (inspectorOpen || layersOn) post({ type: "outline" });
  }, [inspectorOpen, layersOn, post, frameEl, entry?.rel]);

  // A tier switch (or in v2, a turn starting or ending) while selecting turns in-place editing on or off right away.
  useEffect(() => {
    if (picking) post(pickMessage(true));
  }, [pickMessage]);

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

  // The Composer chip says what the kit calls it: `Selection: StatCard`.
  useEffect(() => {
    if (!selection) return;
    const names = selection.elements.map((el) => partLabel(el, kitParts));
    if (selection.names && names.join("\n") === selection.names.join("\n")) return;
    setSelection(threadId, { ...selection, names });
  }, [selection, kitParts, threadId, setSelection]);

  const clearSelection = () => {
    setSelection(threadId, null);
    setAnnouncement(announceSelection([]));
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

  // Pick is the one way to select on the page (the bar's Pick, V, a layer row); in-place text editing follows the tier.
  const togglePick = () => {
    const on = !picking;
    setPicking(on);
    post(pickMessage(on));
  };

  const stopDetect = () => {
    detectRef.current = { run: detectRef.current.run + 1, rel: null, result: null };
    setDetect(null);
    post({ type: "set-findings", findings: [] });
  };
  // `quiet`: a re-run after a reload only moves the pins; the notices were said the first time.
  const runDetect = (rel: string, quiet = false) => {
    const run = detectRef.current.run + 1;
    detectRef.current = { run, rel, result: detectRef.current.result };
    setDetect("busy");
    api()
      .designDetect(threadId, rel)
      .then((result) => {
        if (detectRef.current.run !== run) return;
        detectRef.current = { run, rel, result };
        setDetect(result);
        post({ type: "set-findings", findings: result.pins.map((p) => ({ n: p.n, selector: p.selector, detail: p.details.join("\n") })) });
        if (quiet) return;
        if (result.total === 0) setNotice({ text: "Detect found no issues on this page." });
        else if (result.page.length) setNotice({ text: `Whole page: ${result.page.join("; ")}` });
      })
      .catch((err: unknown) => {
        if (detectRef.current.run !== run) return;
        detectRef.current = { run: run + 1, rel: null, result: null };
        setDetect(null);
        setNotice({ text: ipcError(err), error: true });
      });
  };
  const toggleDetect = () => {
    if (detect !== null) return stopDetect();
    if (entry) runDetect(entry.rel);
  };
  const runDetectRef = useRef(runDetect);
  runDetectRef.current = runDetect;

  const path = entry ? `${entry.dir}/${entry.rel}` : null;
  const outline = pageOutline && pageOutline.path === path ? pageOutline.nodes : NO_NODES;
  const versions = (files?.find((f) => f.path === path)?.versions ?? []).slice().sort((a, b) => b.version - a.version);
  const src = entry ? (version ? `${entry.url}?v=${version}` : entry.url) : null;
  // The latest file remounts on every change; a saved version stays put.
  // In v2 a change on disk is patched in (see `refreshFrame`), so only a reload by hand or a failed patch remounts.
  const frameKey = version ? `v${version}` : `live-${manual}`;
  // A device frame, and the phone and tablet viewports, hide the page's scrollbars (a reload asks again on ready).
  // Phones and tablets draw overlay scrollbars; classic ones take room, so a page exactly the viewport's size could
  // keep both bars up, each one making the other overflow. The page still scrolls.
  const deviceRef = useRef(false);
  const deviceOn = device && deviceFor(viewport) !== null;
  const hideBars = deviceOn || viewport === "mobile" || viewport === "tablet";
  useEffect(() => {
    deviceRef.current = hideBars;
    post({ type: "device-chrome", on: hideBars });
  }, [hideBars, post]);

  // The device chrome (bezel, browser bar) takes room the frame can't use when it fits to the stage.
  const chrome = device ? DEVICE_CHROME[deviceFor(viewport) ?? "none"] : DEVICE_CHROME.none;
  // A page that declares its device (one phone screen, a slide) fits whole until the user picks a viewport.
  // In v2 a desktop page keeps its 1440 layout at any stage width and scrolls inside its frame, which reaches the stage's foot.
  const lockedDesktop = viewport === "desktop" && zoom === "fit" && !device;
  const whole = (device && deviceFor(viewport) !== null) || (viewportPick === null && viewport !== "fit" && !lockedDesktop);
  // Its frame stops above the tools at the stage's foot, so the end of the page can be scrolled clear of them.
  const footRoom = lockedDesktop && stageNode.current ? Math.max(0, (parseFloat(getComputedStyle(stageNode.current).paddingBottom) || 0) - STAGE_PAD) : 0;
  const layout = frameLayout(viewport, zoom, { width: stage.width - chrome.width - (lockedDesktop ? 2 : 0), height: stage.height - chrome.height - footRoom - (lockedDesktop ? 2 : 0) }, whole, lockedDesktop);
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
      setToolState("select");
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
    const ok = await useStore.getState().send("Write the developer handoff for this design.", ["design-review"], threadId);
    if (ok) setNotice({ text: "Writing the handoff first. Choose Build in code again once handoff.md is there." });
  };

  const rel = entry?.rel ?? null;
  useEffect(() => {
    setNotice((n) => (n?.page && n.page !== rel ? null : n));
    setToast(null);
  }, [rel]);
  const pageOverrides = (rel && overrides[rel]) || {};
  const tweakValues: TweakValues = tweaks ? { ...tweaks.base, ...pageOverrides } : {};
  const tweakChanges = tweaks ? changedTweaks(tweaks.base, pageOverrides) : {};
  const tweaksDirty = Object.keys(tweakChanges).length > 0;
  const showTweaks = features.tweaks && !!tweaks && !!entry && version === 0 && !comparing;

  // Fold the header until its tools end inside it. A new width or tool set starts again unfolded; every step runs
  // before paint, so the overflowing layouts are never seen.
  useLayoutEffect(() => {
    const head = headEl.current;
    const tools = toolsEl.current;
    if (!head || !tools) return;
    const key = `${headWidth}|${board}|${comparing}|${versions.length > 0}|${showTweaks}|${!!entry}`;
    if (foldKey.current !== key) {
      foldKey.current = key;
      if (fold !== 0) {
        setFold(0);
        return;
      }
    }
    const end = head.getBoundingClientRect().right - (parseFloat(getComputedStyle(head).paddingRight) || 0);
    if (fold < MAX_FOLD && tools.getBoundingClientRect().right > end + 0.5) setFold(fold + 1);
  });

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
        style={{ ...(fit ? {} : { width: layout.width, height: layout.height, transform: `scale(${layout.scale})` }), ...(appearance ? { colorScheme: appearance } : {}) }}
      />
      {grid && <div className="design-grid" style={{ backgroundSize: `${8 * layout.scale}px ${8 * layout.scale}px` }} aria-hidden />}
    </div>
  ) : null;

  const stageEl = entry && src ? (
    <div className={`design-stage${fit ? " fit" : ""}${lockedDesktop ? " locked" : ""}${kind ? ` device-${kind}` : ""}`} ref={stageRef}>
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

  const viewportPicker = !board && (
    <Select<Viewport> value={viewport} options={VIEWPORTS.map(({ value, label, detail }) => ({ value, label, detail }))} onChange={setViewport} ariaLabel="Viewport" className="ghost-select" />
  );
  const zoomPicker = !board && !fit && <Select<Zoom> value={zoom} options={ZOOMS} onChange={setZoom} ariaLabel="Zoom" className="ghost-select" />;
  const versionPicker = versions.length > 0 && (
    <Select<number>
      value={version}
      options={[{ value: 0, label: "Latest" }, ...versions.map((v) => ({ value: v.version, label: `v${v.version}` }))]}
      onChange={setVersion}
      ariaLabel="Version"
      className="ghost-select"
    />
  );

  // Leaving one page for the board or another page stops selecting there (a selection belongs to one page).
  const stopPicking = () => {
    if (!picking) return;
    setPicking(false);
    post({ type: "pick", on: false });
  };
  const openBoard = () => {
    stopPicking();
    setCompare(false);
    setVersion(0);
    chooseBoard(true);
  };
  const openPage = (to: string) => {
    chooseBoard(false);
    setCompare(false);
    setVersion(0);
    scroll.current = { x: 0, y: 0 };
    setPage(to);
  };

  // The page tools work on one live page: elsewhere they say what to do first.
  const onPage = !!entry && !!src && version === 0 && !board && !comparing;
  // Detect belongs to one live page: another page, the board, Compare or an old version ends it.
  useEffect(() => {
    const rel = detectRef.current.rel;
    if (rel !== null && (!onPage || rel !== entry?.rel)) stopDetect();
  }, [onPage, entry?.rel]);
  // In v2 the page is always selectable: there's no Pick to turn on, except while Insert has the pointer.
  useEffect(() => {
    if (!onPage || picking || view === "preview") return;
    setPicking(true);
    post(pickMessage(true));
  }, [onPage, picking, post, pickMessage, view]);
  // Preview hands the page to the visitor: no selecting, and the selection waits until Design comes back.
  const changeView = (next: StudioView) => {
    if (next === view) return;
    if (next === "preview") {
      heldSelection.current = useStore.getState().designSelection[threadId];
      clearSelection();
      stopPicking();
    } else if (view === "preview" && heldSelection.current) {
      setSelection(threadId, heldSelection.current);
      heldSelection.current = undefined;
    }
    setViewState(next);
  };
  // Another part of the app asked for a view: `Customize a copy` opens System on the new theme.
  const studioRequest = useStore((s) => s.studioRequest);
  useEffect(() => {
    if (!studioRequest?.view || studioRequest.threadId !== threadId) return;
    useStore.getState().requestStudio(null);
    changeView(studioRequest.view);
    // A turn card's version: shown on the canvas with the version pill, which goes back to Latest.
    if (studioRequest.version !== undefined && versions.some((v) => v.version === studioRequest.version)) {
      setVersion(studioRequest.version);
      setVersionPill(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioRequest]);
  // Below 1000px (or when a side panel narrows the canvas below 952px) the Layers rail starts collapsed and Customize stays closed until asked for, since it floats over the page.
  // Measured on the canvas itself, as the CSS container (studio-head on .design-canvas) is: the header is narrower.
  const [canvasWidth, setCanvasWidth] = useState(0);
  const canvasEl = useRef<HTMLElement | null>(null);
  const canvasObserver = useRef<ResizeObserver | null>(null);
  const canvasRef = useCallback((el: HTMLElement | null) => {
    canvasObserver.current?.disconnect();
    canvasObserver.current = null;
    canvasEl.current = el;
    if (!el) return;
    setCanvasWidth(el.clientWidth);
    canvasObserver.current = new ResizeObserver(() => setCanvasWidth(el.clientWidth));
    canvasObserver.current.observe(el);
  }, []);
  const isCanvasNarrow = (width: number) => width > 0 && width < 952;
  const canvasNarrow = isCanvasNarrow(canvasWidth);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 999px)");
    const isNarrow = narrow.matches || isCanvasNarrow(canvasEl.current?.clientWidth ?? 0);
    setInspectorOpen(!isNarrow);
    const apply = () => {
      const nowNarrow = narrow.matches || isCanvasNarrow(canvasEl.current?.clientWidth ?? 0);
      setRailFolded(nowNarrow);
      if (nowNarrow) setInspectorOpen(false);
    };
    apply();
    narrow.addEventListener("change", apply);
    return () => narrow.removeEventListener("change", apply);
  }, [threadId]);
  useEffect(() => {
    const windowNarrow = window.matchMedia("(max-width: 999px)").matches;
    const nowNarrow = windowNarrow || canvasNarrow;
    setRailFolded(nowNarrow);
    if (nowNarrow) setInspectorOpen(false);
  }, [canvasNarrow]);
  const toggleRail = () => {
    if (railSaved && (railFolded || canvasNarrow || window.matchMedia("(max-width: 999px)").matches)) setRailFolded(!railFolded);
    else {
      setRailFolded(false);
      setPaneLayout({ designRail: !railSaved }, true);
    }
  };
  const toggleRailRef = useRef(toggleRail);
  toggleRailRef.current = toggleRail;
  // The canvas's keys in v2, with the keyboard in the app rather than the frame. A text field keeps its own.
  const keyState = useRef({ onPage, cycling: false });
  keyState.current = { onPage: onPage && view === "design", cycling: variantSets.length > 0 };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const now = keyState.current;
      if (e.defaultPrevented || !now.onPage) return;
      const t = e.target as HTMLElement | null;
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggleRailRef.current();
        return;
      }
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      if (!e.repeat && (!t || !t.closest('[role="dialog"], [role="menu"], [role="listbox"]')) && studioRef.current.key(e.key, e.metaKey || e.ctrlKey, e.shiftKey, e.altKey)) {
        e.preventDefault();
        return;
      }
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && e.key === "'") {
        e.preventDefault();
        setGrid((g) => !g);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (k === "z" || k === "y")) {
        e.preventDefault();
        (k === "y" || e.shiftKey ? editsRef.current.redo : undoRef.current)();
        return;
      }
      // Read when the key lands, not at the last render: the selection may have just changed.
      if (!useStore.getState().designSelection[threadId]?.elements.length || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const free = !t || t === document.body;
      if (e.key === "Escape" ? !escClears(e.target) : !free || !/^(Enter|Arrow(Up|Down|Left|Right))$/.test(e.key) || now.cycling) return;
      e.preventDefault();
      post({ type: "key", key: e.key, alt: e.altKey });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [post, threadId]);
  const presentFrom = entry ? (board ? flowOrder(entry.pages)[0] : entry.rel) : undefined;

  // A stage that scrolls (a sized frame larger than the stage) moves the element under the bar: place it again.
  useEffect(() => {
    const el = stageNode.current;
    if (!el) return;
    const onScroll = () => setStageScrolled((n) => n + 1);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [frameEl]);

  // The frame's anchor in the stage wrapper's coordinates, and the part of the frame that shows (the stage's
  // content box, so the bar never sits on the live bar or the prompt bar).
  const toWrap = (r: FrameRect): { el: FrameRect; view: FrameRect; origin: { x: number; y: number } } | null => {
    const frame = frameRef.current;
    const wrap = wrapRef.current;
    const stageBox = stageNode.current;
    if (!frame || !wrap || !stageBox) return null;
    const fr = frame.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const sr = stageBox.getBoundingClientRect();
    const scale = frame.offsetWidth ? fr.width / frame.offsetWidth : 1;
    const padBottom = parseFloat(getComputedStyle(stageBox).paddingBottom) || 0;
    const top = Math.max(fr.top, sr.top);
    const bottom = Math.min(fr.bottom, sr.bottom - padBottom);
    const left = Math.max(fr.left, sr.left);
    const right = Math.min(fr.right, sr.right);
    return {
      el: { x: fr.left - wr.left + r.x * scale, y: fr.top - wr.top + r.y * scale, width: r.width * scale, height: r.height * scale },
      view: { x: left - wr.left, y: top - wr.top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
      origin: { x: wr.left, y: wr.top },
    };
  };
  const showElementBar = onPage && selected.length > 0 && anchor !== null;
  const barBoxes = showElementBar && anchor ? toWrap(anchor.rect) : null;
  // An Explore action: 3 variants of the selection in one direction, with the variants skill and that direction's note.
  const go = async (chosen: ActionId, words = "") => {
    if (!entry || !selected.length || agentRunning) return;
    const text = goMessage(chosen, words);
    const note = await api().designActionNote(chosen).catch(() => "");
    await useStore.getState().send(withScope(note ? `${text}\n\n${note}` : text, `${entry.dir}/${entry.rel}`, selected), [VARIANTS_SKILL], threadId);
  };

  // The cycler for the page's first variant set (a well-formed one before a malformed one).
  const activeSet = onPage ? (variantSets.find((v) => v.malformed === null) ?? variantSets[0] ?? null) : null;
  const showVariant = (n: number) => {
    if (!activeSet) return;
    post({ type: "show-variant", set: activeSet.set, n });
    setVariantSets((list) => list.map((v) => (v.set === activeSet.set ? { ...v, shown: n } : v)));
  };
  const resolveSet = async (keep: number | null) => {
    if (!activeSet || !entry || resolving) return;
    setResolving(true);
    try {
      await api().designVariantResolve(threadId, entry.rel, activeSet.set, keep);
      setNotice({
        text: keep === null ? "Back to the original. The variants are saved as a version." : `Kept variant ${keep}. The page before is saved as a version.`,
        page: entry.rel,
      });
    } catch (err) {
      setNotice({ text: ipcError(err), error: true });
    } finally {
      setResolving(false);
    }
  };
  // ← and → cycle the variants while the focus isn't in a text field.
  const cycleRef = useRef({ activeSet, showVariant });
  cycleRef.current = { activeSet, showVariant };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { activeSet: set, showVariant: show } = cycleRef.current;
      if (!set || set.malformed || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      const next = cycleStep(set.shown, set.count, e.key);
      if (next === null) return;
      e.preventDefault();
      show(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const cyclerBoxes = activeSet && variantRect?.set === activeSet.set && variantRect.rect ? toWrap(variantRect.rect) : null;
  // A set with no box to sit under (malformed, or its element is hidden) docks the cycler to the foot of the frame.
  const cyclerView = cyclerBoxes?.view ?? (activeSet ? toWrap({ x: 0, y: 0, width: 0, height: 0 })?.view : null);
  const cyclerPlace =
    activeSet && cyclerView && cyclerSize.width > 0
      ? placeFloatingBar(cyclerBoxes?.el ?? { x: cyclerView.x, y: cyclerView.y + cyclerView.height + 1000, width: cyclerView.width, height: 0 }, cyclerView, cyclerSize)
      : null;
  const cycler = activeSet ? (
    <VariantCycler
      shown={activeSet.shown}
      count={activeSet.count}
      malformed={activeSet.malformed}
      place={cyclerPlace}
      onSize={setCyclerSize}
      onShow={showVariant}
      onAccept={() => void resolveSet(activeSet.shown >= 1 ? activeSet.shown : 1)}
      onDiscard={() => void resolveSet(null)}
      busy={resolving}
    />
  ) : null;

  // --- The studio's selection, tools and structural edits (Swap, Insert, Wrap, the Actions menu) ---

  const toWrapPoint = (x: number, y: number) => toWrap({ x, y, width: 0, height: 0 })?.el ?? { x: 16, y: 16 };
  // Popovers stop above the Composer, which floats over the stage's foot.
  const composerRoom = stageNode.current ? parseFloat(getComputedStyle(stageNode.current).paddingBottom) || 0 : 0;
  // A narrow window floats Customize over the stage's right side: the studio's handles and popovers stop at its edge.
  const floatingPanel = wrapRef.current?.parentElement?.querySelector<HTMLElement>(":scope > .design-customize");
  const panelCut = floatingPanel && wrapRef.current && getComputedStyle(floatingPanel).position === "absolute" ? Math.max(0, wrapRef.current.getBoundingClientRect().right - floatingPanel.getBoundingClientRect().left) : 0;
  const wrapBounds: FrameRect = { x: 0, y: 0, width: Math.max(0, (wrapRef.current?.clientWidth ?? 0) - panelCut), height: Math.max(0, (wrapRef.current?.clientHeight ?? 0) - composerRoom) };
  const targetOf = (el: Pick<SelectedElement, "id" | "tag" | "at">) => (el.id ? { id: el.id } : el.at ? { locator: { tag: el.tag, path: el.at } } : null);
  const one = selected.length === 1 ? (selected[0] ?? null) : null;
  const oneAttrs = one ? startAttrs(one.html) : {};
  const onePart = (one && kitParts.find((p) => p.ui === oneAttrs["data-ui"])) || null;
  const selectionName = one ? partLabel(one, kitParts) : `${selected.length} selected`;
  const closePopovers = () => {
    setSwapAt(null);
    setActionsAt(null);
    setPalette(null);
  };
  const setTool = (next: CanvasTool) => {
    closePopovers();
    // Comment on what's already selected: a click on it wouldn't change the selection, so nothing else would open the note.
    setCommentDraft(next === "comment" && selected.length === 1 ? "" : null);
    setToolState(next);
    if (next === "draw") clearSelection();
  };
  const notAnchored = "This element can't be edited here. Ask the agent to change it.";
  const wrapSelection = (shape: WrapShape) => {
    closePopovers();
    const [first, ...rest] = selected;
    const to = first && targetOf(first);
    if (!first || !to) return setNotice({ text: notAnchored, error: true });
    void edits.transaction(async (step) => {
      const extraIds: string[] = [];
      // Wrapping names the other elements by id, so each one that has none gets one now.
      for (const el of rest) {
        const target = targetOf(el);
        if (!target) throw new Error(notAnchored);
        extraIds.push(el.id ?? (await step(target, { kind: "setProp", name: "data-cubiq-stamp", value: null })).stampedId ?? "");
      }
      const result = await step(to, { kind: "wrap", extraIds, tag: "div", attrs: wrapAttrs(shape, selected.length, kitParts) });
      pendingSelect.current = result.createdIds?.[0] ?? null;
    });
  };
  const unwrapSelection = () => {
    closePopovers();
    const to = one && targetOf(one);
    if (!to) return;
    clearSelection();
    void edits.transaction((step) => step(to, { kind: "unwrap" }));
  };
  const duplicateSelection = () => {
    closePopovers();
    const list = selected.map(targetOf);
    if (!list.length || list.some((t) => !t)) return setNotice({ text: notAnchored, error: true });
    void edits.transaction(async (step) => {
      // Last first, so an element found by its place isn't moved by an earlier copy.
      for (const to of [...list].reverse()) {
        const result = await step(to!, { kind: "duplicate" });
        pendingSelect.current = result.createdIds?.[0] ?? null;
      }
    });
  };
  const styleElement = (el: SelectedElement | null, changes: { prop: string; value: string }[], key: string) => {
    const target = el ? { ...(el.id ? { id: el.id } : {}), selector: el.selector, tag: el.tag, text: "" } : { selector: "html", tag: "html", text: "" };
    post({ type: "apply-style", target, changes });
    // Page tokens change what the panel shows beside them.
    if (!el) setPageTheme((t) => ({ ...t, ...Object.fromEntries(changes.map((c) => [c.prop, c.value])) }));
    const to = el ? (el.id ? { id: el.id } : el.at ? { locator: { tag: el.tag, path: el.at } } : null) : { locator: { tag: "html", path: [] } };
    if (to) edits.sendSoon(key, to, { kind: "setStyle", changes });
  };
  const retagElement = (el: SelectedElement, tag: string) => {
    closePopovers();
    const to = targetOf(el);
    if (!to) return setNotice({ text: notAnchored, error: true });
    void edits.transaction(async (step) => {
      const result = await step(to, { kind: "retag", tag });
      // The same element under a new tag: select it again once the page has it.
      pendingSelect.current = el.id ?? result.stampedId ?? null;
    });
  };
  const deleteSelection = () => {
    closePopovers();
    const list = selected.map(targetOf);
    if (!list.length || list.some((t) => !t)) return setNotice({ text: notAnchored, error: true });
    clearSelection();
    void edits.transaction(async (step) => {
      for (const to of [...list].reverse()) await step(to!, { kind: "remove" });
    });
  };
  const applyAttrs = (el: SelectedElement, changes: AttrChange[], key: string) => {
    const to = targetOf(el);
    if (!to) return setNotice({ text: notAnchored, error: true });
    for (const c of changes) {
      post({ type: "apply-attr", target: { ...(el.id ? { id: el.id } : {}), selector: el.selector, tag: el.tag, text: "" }, name: c.name, value: c.value });
      edits.send(to, { kind: "setProp", name: c.name, value: c.value }, key);
    }
  };
  const swapTo = (next: KitPart) => {
    closePopovers();
    const to = one && targetOf(one);
    if (!one || !to) return setNotice({ text: notAnchored, error: true });
    const plan = swapPlan(one.html, one.text, onePart, next);
    const from = selectionName;
    void edits
      .transaction(async (step) => {
        if (plan.kind === "attrs") {
          let id = one.id ?? null;
          for (const c of plan.changes) {
            const result = await step(id ? { id } : to, { kind: "setProp", name: c.name, value: c.value });
            id = id ?? result.stampedId ?? null;
          }
          pendingSelect.current = id;
        } else {
          const made = await step(to, { kind: "insert", html: plan.html, position: "after" });
          const id = one.id ?? made.stampedId;
          await step(id ? { id } : to, { kind: "remove" });
          pendingSelect.current = made.createdIds?.[0] ?? null;
        }
        return true;
      })
      .then((done) => done && setToast(swapNotice(from, next, plan.dropped)));
  };
  /** A part as it goes on a page: a kit's whole-page block is a pointer to its file, so this reads the file. */
  const withBlock = async (part: KitPart): Promise<KitPart> => {
    const file = blockFile(part);
    if (!file || !entry) return part;
    const res = await api().readArtifact(threadId, `${entry.dir}/system/${file}`);
    if (!res.ok) throw new Error(`Couldn't read ${part.name} from the kit.`);
    return { ...part, snippet: res.text ?? part.snippet };
  };
  const insertPart = (part: KitPart, position: SeamPosition) => {
    const anchorEl = palette?.anchor;
    const to = anchorEl && targetOf(anchorEl);
    closePopovers();
    if (!to) return setNotice({ text: notAnchored, error: true });
    void edits.transaction(async (step) => {
      const result = await step(to, { kind: "insert", html: instanceOf(await withBlock(part)), position: position === "inside" ? "inside-end" : position });
      pendingSelect.current = result.createdIds?.[0] ?? null;
    });
  };
  const askAtSeam = async (text: string, position: "before" | "after") => {
    const anchorEl = palette?.anchor;
    if (!entry || !anchorEl) return;
    closePopovers();
    await useStore.getState().send(insertMessage(`${entry.dir}/${entry.rel}`, { position, anchor: anchorEl, size: { width: Math.round(anchorEl.rect.width), height: Math.round(anchorEl.rect.height) } }, text), [VARIANTS_SKILL], threadId);
  };
  const focusComposer = () => document.querySelector<HTMLTextAreaElement>(".thread-bar textarea")?.focus();
  const openCodeAt = async (el: SelectedElement) => {
    if (!entry) return;
    const res = await api().readArtifact(threadId, `${entry.dir}/${entry.rel}`).catch(() => null);
    setCodeLine(res?.ok && typeof res.text === "string" ? lineOf(res.text, el.id, el.html) : null);
    changeView("code");
  };
  const selectionAt = () => (barBoxes ? { x: barBoxes.el.x, y: barBoxes.el.y + barBoxes.el.height + 8 } : { x: 16, y: 16 });
  const openPaletteHere = () => {
    if (one) setPalette({ anchor: one, position: "after", at: selectionAt() });
  };
  // `Variant › Body md`: a text part's type style, a component's variant, or plain text's step on the kit's type scale.
  const variantSwitches = (): ActionItem[] => {
    if (!one) return [];
    const textProp = textVariantProp(onePart?.ui, onePart?.props ?? []);
    const prop = textProp ?? (onePart?.props.find((p) => p.name === "variant" && p.options?.length) ? { name: "variant", options: onePart!.props.find((p) => p.name === "variant")!.options! } : null);
    if (prop) {
      const now = oneAttrs[`data-${prop.name}`] ?? prop.options[0];
      return prop.options.map((v) => ({
        id: `v-${v}`,
        group: "Variant",
        label: `Variant › ${textProp ? optionLabel(prop.name, v) : `${v[0]!.toUpperCase()}${v.slice(1)}`}`,
        disabled: v === now,
        run: () => applyAttrs(one, [{ name: `data-${prop.name}`, value: v === prop.options[0] ? null : v }], `${one.selector}:data-${prop.name}`),
      }));
    }
    if (onePart || !one.ownText || !(RETAG_TAGS as readonly string[]).includes(one.tag)) return [];
    const scale = typeScale(pageTheme);
    const now = scaleStepOf(scale, inlineStyle(oneAttrs.style, "font-size"), one.style?.fontSize);
    return scale.map((st) => ({
      id: `t-${st.id}`,
      group: "Variant",
      label: `Variant › ${st.label}`,
      shortcut: st.meta,
      disabled: st.id === now,
      run: () => styleElement(one, scaleChanges(st.id, pageTheme), `${one.selector}:type`),
    }));
  };
  // `Move to…`: the click after it picks the element it goes next to (or into), then the menu asks where.
  const moveTarget = moving && one && !moving.some((m) => (m.id && m.id === one.id) || m.selector === one.selector) ? one : null;
  const moveSelection = (position: InsertPosition) => {
    const list = moving;
    const ref = moveTarget;
    closePopovers();
    setMoving(null);
    setNotice(null);
    if (!list || !ref) return;
    const refTo = targetOf(ref);
    const tos = list.map(targetOf);
    if (!refTo || tos.some((t) => !t)) return setNotice({ text: notAnchored, error: true });
    void edits.transaction(async (step) => {
      // A move names its reference by id, and later moves find the moving elements by id: each one without gets one first.
      const stamp = async (el: SelectedElement, to: NonNullable<ReturnType<typeof targetOf>>) => el.id ?? (await step(to, { kind: "setProp", name: "data-cubiq-stamp", value: null })).stampedId ?? "";
      const refId = await stamp(ref, refTo);
      const ids: string[] = [];
      for (const [i, el] of list.entries()) ids.push(await stamp(el, tos[i]!));
      if (!refId || ids.some((id) => !id)) throw new Error(notAnchored);
      // Each move lands right next to the reference, so `after` and `inside-start` go last-first to keep their order.
      for (const id of position === "after" || position === "inside-start" ? [...ids].reverse() : ids) await step({ id }, { kind: "move", refId, position });
      pendingSelect.current = ids[0] ?? null;
    });
  };
  const startMove = () => {
    closePopovers();
    setMoving([...selected]);
    setNotice({ text: `Click where ${selected.length === 1 ? "it goes" : "they go"}. Esc cancels.` });
  };
  const copyContext = () => {
    if (!entry || !selected.length) return;
    void navigator.clipboard?.writeText(contextBlock(`${entry.dir}/${entry.rel}`, selected, one ? selectionName : undefined)).then(() => setToast("Context copied"));
  };
  const goToComponent = () => {
    if (!onePart) return;
    closePopovers();
    setSystemStart(onePart.ui);
    changeView("system");
  };
  const moveItems: ActionItem[] = moveTarget
    ? [
        { id: "move-before", group: "Move", label: `Before ${partLabel(moveTarget, kitParts)}`, run: () => moveSelection("before") },
        { id: "move-after", group: "Move", label: `After ${partLabel(moveTarget, kitParts)}`, run: () => moveSelection("after") },
        { id: "move-first", group: "Move", label: "Inside, first", run: () => moveSelection("inside-start") },
        { id: "move-last", group: "Move", label: "Inside, last", run: () => moveSelection("inside-end") },
        { id: "move-cancel", group: "Move", label: "Cancel move", run: () => (closePopovers(), setMoving(null), setNotice(null)) },
      ]
    : [];
  const actionItems: ActionItem[] = moveTarget
    ? moveItems
    : !selected.length
    ? []
    : [
        ...(onePart ? [{ id: "swap", group: "Structure", label: "Swap component…", shortcut: "⌘S", run: () => setSwapAt(selectionAt()) }] : []),
        ...wrapShapes(kitParts).map((s) => ({ id: `wrap-${s}`, group: "Structure", label: `Wrap in ${s[0]!.toUpperCase()}${s.slice(1)}`, shortcut: s === "stack" ? "⌘G" : s === "grid" ? "⌥⌘G" : undefined, run: () => wrapSelection(s) })),
        { id: "unwrap", group: "Structure", label: "Unwrap", shortcut: "⌘⇧G", disabled: !one, run: unwrapSelection },
        { id: "insert", group: "Structure", label: "Insert…", shortcut: "I", disabled: !one, run: openPaletteHere },
        { id: "move", group: "Structure", label: "Move to…", run: startMove },
        { id: "duplicate", group: "Structure", label: "Duplicate", shortcut: "⌘D", run: duplicateSelection },
        ...(kitParts.length ? [{ id: "composition", group: "Structure", label: "Save as composition…", run: () => setNaming({ kind: "composition", warnings: [], error: null, busy: false }) }] : []),
        { id: "delete", group: "Structure", label: "Delete", shortcut: "⌫", run: deleteSelection },
        ...variantSwitches(),
        ...(onePart ? [{ id: "reset", group: "Component", label: "Reset all props", run: () => one && applyAttrs(one, onePart.props.filter((p) => oneAttrs[`data-${p.name}`] !== undefined).map((p) => ({ name: `data-${p.name}`, value: null })), `${one.selector}:reset`) }] : []),
        { id: "chat", group: "Component", label: "Add to chat", run: focusComposer },
        { id: "context", group: "Component", label: "Copy context", run: copyContext },
        ...(onePart ? [{ id: "component", group: "Component", label: "Go to component", run: goToComponent }] : []),
        { id: "comment", group: "Component", label: "Add comment", shortcut: "C", disabled: !one, run: () => setCommentDraft("") },
        { id: "code", group: "Component", label: "Go to code", disabled: !one, run: () => one && void openCodeAt(one) },
        { id: "copy", group: "Component", label: jsxOf(onePart, oneAttrs, one?.ownText ?? one?.text ?? "") ? "Copy JSX" : "Copy HTML", disabled: !one, run: () => one && void navigator.clipboard?.writeText(jsxOf(onePart, oneAttrs, one.text) ?? one.html) },
        ...[...VARIANT_DIRECTIONS, ...MORE_DIRECTIONS].map((d) => ({ id: `ai-${d.id}`, group: "Explore", label: `3 variants: ${d.label}`, disabled: agentRunning, run: () => void go(d.id, "") })),
      ];
  const saveTheme = async (name: string) => {
    setNaming((n) => n && { ...n, busy: true, error: null });
    try {
      await edits.flush();
      const saved = await api().designSaveTheme(threadId, name, pageInline);
      useStore.getState().apply({ type: "thread", thread: saved.thread });
      // The theme holds them now, and the page goes back to following it: dark included.
      const clear = saved.applied.slice(0, 32).map((prop) => ({ prop, value: "" }));
      if (clear.length) await edits.transaction(async (step) => step({ locator: { tag: "html", path: [] } }, { kind: "setStyle", changes: clear }));
      setNaming(null);
      setToast(`Saved as ${name}. It's in the Style picker.`);
    } catch (err) {
      setNaming((n) => n && { ...n, busy: false, error: ipcError(err) });
    }
  };
  const saveComposition = async (name: string, force: boolean) => {
    const html = selected.map((el) => el.html ?? "").join("\n");
    setNaming((n) => n && { ...n, busy: true, error: null });
    try {
      const res = await api().designSaveComposition(threadId, name, html, force);
      if (res.saved === null) return setNaming({ kind: "composition", warnings: res.warnings, error: null, busy: false });
      useStore.getState().apply({ type: "thread", thread: res.thread });
      setNaming(null);
      setToast(`Saved ${name}. It's in Insert and Swap.`);
      setManual((n) => n + 1);
    } catch (err) {
      setNaming((n) => n && { ...n, busy: false, error: ipcError(err) });
    }
  };
  const commentForm =
    commentDraft !== null && selected.length === 1 && !comparing && version === 0 ? (
        <form
          className={"design-comment-new studio-comment"}
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
                setToolState("select");
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
    ) : null;
  studioRef.current = {
    toolOf: () => tool,
    context: (x, y) => {
      setTool("select");
      setActionsAt(toWrapPoint(x, y));
    },
    key: (key, mod, shift, alt) => {
      if (view !== "design" || !onPage) return false;
      const k = key.toLowerCase();
      const chosen = toolForKey({ key, metaKey: mod, ctrlKey: false, altKey: alt, shiftKey: shift });
      if (chosen && !(palette || swapAt || actionsAt)) {
        setTool(chosen);
        return true;
      }
      if (!selected.length) return false;
      if (mod && k === "g") {
        if (shift) unwrapSelection();
        else wrapSelection(alt ? "grid" : "stack");
        return true;
      }
      if (mod && k === "d" && !shift) {
        duplicateSelection();
        return true;
      }
      if (mod && k === "s" && onePart) {
        setSwapAt(selectionAt());
        return true;
      }
      if (mod) return false;
      if (key === "Backspace" || key === "Delete") {
        deleteSelection();
        return true;
      }
      if (k === "i" && one) {
        openPaletteHere();
        return true;
      }
      if (key === "/") {
        setActionsAt(selectionAt());
        return true;
      }
      return false;
    },
  };
  // The pick for `Move to…` opens the menu on it; Esc drops the move.
  useEffect(() => {
    if (moveTarget && barBoxes) setActionsAt(selectionAt());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving, selectedKey, barBoxes === null]);
  useEffect(() => {
    if (!moving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMoving(null);
      setNotice(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moving]);
  // Esc stands a tool down, once its own popovers have had the key.
  useEffect(() => {
    if (tool === "select") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !escClears(e.target)) return;
      setToolState("select");
      setCommentDraft(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);
  // A saved page's parts, from the manifest in its folder. A flat style has none.
  const kitDir = entry?.dir ?? null;
  useEffect(() => {
    if (!kitDir) return setKitParts([]);
    let live = true;
    void api()
      .readArtifact(threadId, `${kitDir}/system/components.json`)
      .then((res) => live && setKitParts(parseKitParts(res.ok ? res.text : null)))
      .catch(() => live && setKitParts([]));
    return () => {
      live = false;
    };
  }, [threadId, kitDir, reload]);
  const sendDrawing = async (strokes: Stroke[], note: string) => {
    const wrap = wrapRef.current;
    const frame = frameRef.current;
    const box = strokeBounds(strokes, 24);
    if (!wrap || !frame || !entry || !box || agentRunning) return;
    const wr = wrap.getBoundingClientRect();
    const x = Math.max(0, box.x);
    const y = Math.max(0, box.y);
    const width = Math.min(wr.width - x, box.width);
    const height = Math.min(wr.height - y, box.height);
    setDrawCapturing(true);
    try {
      // What the marks circle, asked of the page at their centre.
      const fr = frame.getBoundingClientRect();
      const scale = frame.offsetWidth ? fr.width / frame.offsetWidth : 1;
      const near = await new Promise<SelectedElement | null>((done) => {
        const timer = setTimeout(() => done(null), 400);
        hitWaiter.current = (el) => {
          clearTimeout(timer);
          hitWaiter.current = null;
          done(el);
        };
        post({ type: "hit-test", x: (wr.left + x + width / 2 - fr.left) / scale, y: (wr.top + y + height / 2 - fr.top) / scale });
      });
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      const shot = await api().designCapture(threadId, { x: wr.left + x, y: wr.top + y, width, height });
      const body = withRefs(withScope(drawMessage(note, near ? elementLabel(near) : null), `${entry.dir}/${entry.rel}`, near ? [near] : []), [shot.path]);
      if (await useStore.getState().send(body, undefined, threadId, [shot.path])) setToolState("select");
    } catch (err) {
      setNotice({ text: `Couldn't send the drawing: ${ipcError(err)}`, error: true });
    } finally {
      setDrawCapturing(false);
    }
  };
  const seamBoxes = seam && view === "design" && tool === "select" && onPage && !agentRunning && !palette ? toWrap(seam.rect)?.el : null;
  // The last theme switch, kit move or System mode edit, with its Undo: shown in Design and System views.
  const stepToast =
    systemStep && stepShown ? (
      <div className="studio-toast" role="status">
        <span title={systemStep.text}>{systemStep.text}</span>
        <button className="button ghost studio-toast-undo" onClick={() => undoStep()}>
          Undo <kbd className="studio-toast-kbd">{MOD_KEY}Z</kbd>
        </button>
        <button className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => setStepShown(false)}>
          <IconClose />
        </button>
      </div>
    ) : null;
  const studioLayer = onPage && view === "design" ? (
    <>
      <div className="studio-tool-row">
        <CanvasToolsPill tool={tool} onTool={setTool} />
        {pageComments.length > 0 && (
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
      </div>
      {showElementBar && barBoxes && tool !== "draw" && (
        <SelectionChrome el={barBoxes.el} view={barBoxes.view} bounds={wrapBounds} label={selectionName} canSwap={!!onePart && kitParts.length > 1} onSwap={() => setSwapAt(selectionAt())} />
      )}
      {seamBoxes && seam && <SeamButton rect={seamBoxes} position={seam.position} onOpen={() => setPalette({ anchor: seam.anchor, position: seam.position, at: { x: seamBoxes.x + seamBoxes.width / 2 - 150, y: seamBoxes.y + 12 } })} />}
      {palette && (
        <SeamPalette
          at={palette.at}
          bounds={wrapBounds}
          anchorName={`${palette.position === "inside" ? "In" : palette.position === "before" ? "Before" : "After"} ${elementLabel(palette.anchor)}`}
          position={palette.position}
          parts={kitParts}
          busy={agentRunning ? "Wait for the current turn to finish" : null}
          onInsert={insertPart}
          onAsk={(text, side) => void askAtSeam(text, side)}
          onClose={() => setPalette(null)}
        />
      )}
      {swapAt && one && (
        <SwapPopover
          at={swapAt}
          bounds={wrapBounds}
          name={selectionName}
          parts={kitParts}
          ui={onePart?.ui}
          warn={(to) => {
            const dropped = swapPlan(one.html, one.text, onePart, to).dropped;
            return dropped.length ? `Becomes ${to.name}. Drops ${dropped.join(", ")}, which ${to.name} doesn't take.` : `Becomes ${to.name}.`;
          }}
          onSwap={swapTo}
          onClose={() => setSwapAt(null)}
        />
      )}
      {commentForm}
      {naming && (
        <NamePrompt
          title={naming.kind === "theme" ? "Save as new theme" : "Save as composition"}
          hint={naming.kind === "theme" ? "Keeps this page's changed values as a theme in this project. It joins the Style picker." : "It joins Insert and Swap. Pages get a copy, so editing it later doesn't change earlier ones."}
          warnings={naming.warnings}
          busy={naming.busy}
          error={naming.error}
          onCancel={() => setNaming(null)}
          onSave={(name, force) => void (naming.kind === "theme" ? saveTheme(name) : saveComposition(name, force))}
        />
      )}
      {!toast && stepToast}
      {toast && (
        <div className="studio-toast" role="status">
          <span title={toast}>{toast}</span>
          <button className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => setToast(null)}>
            <IconClose />
          </button>
        </div>
      )}
      {actionsAt && actionItems.length > 0 && (
        <ActionsMenu
          at={actionsAt}
          bounds={wrapBounds}
          title={moveTarget && moving ? `Move ${moving.length === 1 ? partLabel(moving[0]!, kitParts) : `${moving.length} elements`} to…` : selectionName}
          items={actionItems}
          onAsk={(text) => {
            if (entry) void useStore.getState().send(withScope(text, `${entry.dir}/${entry.rel}`, selected), undefined, threadId);
          }}
          onClose={() => setActionsAt(null)}
        />
      )}
      {tool === "draw" && <DrawLayer busy={agentRunning ? "Wait for the current turn to finish" : null} capturing={drawCapturing} onSend={(s, n) => void sendDrawing(s, n)} onCancel={() => setToolState("select")} />}
    </>
  ) : null;

  // Canvas-first's left rail: the design's pages (a click opens one, All pages opens the board) and the open page's layers.
  const rail = railOpen ? (
    <aside className="design-rail" aria-label="Pages and layers">
      <nav className="design-rail-pages" aria-label="Pages">
        <h2 className="design-rail-head">Pages</h2>
        <div className="design-rail-scroll">
          {entry && entry.pages.length > 1 && (
            <button className={`design-rail-row${board && version === 0 ? " selected" : ""}`} aria-current={board && version === 0 ? "page" : undefined} onClick={openBoard}>
              <LayoutGrid size={14} strokeWidth={1.75} aria-hidden />
              <span className="design-rail-label">All pages</span>
              <span className="design-rail-count">{entry.pages.length}</span>
            </button>
          )}
          {entry ? (
            boardSections(entry.pages).map((section) => (
              <div key={section.title} role="group" aria-label={section.title}>
                {/* The plain pages sit right under the Pages heading; other sections (Options, flows) get their own. */}
                {section.title !== "Pages" && <div className="design-rail-group">{section.title}</div>}
                {section.pages.map((p) => {
                  const current = !board && !comparing && entry.rel === p.rel;
                  return (
                    <button key={p.rel} className={`design-rail-row page${current ? " selected" : ""}`} aria-current={current ? "page" : undefined} title={p.rel} onClick={() => openPage(p.rel)}>
                      <span className="design-rail-thumb" aria-hidden>{thumbs[p.rel] ? <img src={thumbs[p.rel]} alt="" draggable={false} /> : null}</span>
                      <span className="design-rail-label">{frameLabel(p, undefined, styleOf)}</span>
                      {(written === "all" || writing.has(p.rel)) && <span className="design-rail-dot" title="Written this turn" />}
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <p className="design-rail-empty">{loaded ? "No pages yet." : ""}</p>
          )}
        </div>
      </nav>
      <section className="design-rail-layers" aria-label="Layers">
        <h2 className="design-rail-head">Layers</h2>
        {layersOn && entry ? (
          <ElementsTree
            key={path}
            nodes={outline}
            selected={selected[0] ?? null}
            others={selected.slice(1)}
            onPick={(n, add) => {
              // Picking a layer selects it on the page, so Pick goes on first.
              if (!picking) togglePick();
              const target = { ...(n.id ? { id: n.id } : {}), selector: n.selector, tag: n.tag, text: "" };
              // Shift adds it to the selection, or takes it out again (v2's multi-select).
              const others = add ? selected.map(({ id, selector, tag, text }) => ({ id, selector, tag, text })) : [];
              const without = others.filter((t) => t.selector !== n.selector);
              post({ type: "set-selection", targets: without.length !== others.length ? without : [...others, target] });
            }}
            onHover={(n) => post({ type: "hover-layer", target: n ? { ...(n.id ? { id: n.id } : {}), selector: n.selector, tag: n.tag, text: "" } : null })}
          />
        ) : (
          <p className="design-rail-empty">{!entry ? "No page yet." : board ? "Open a page to see its layers." : comparing ? "Open one option to see its layers." : "Back to the latest version to see its layers."}</p>
        )}
      </section>
    </aside>
  ) : null;

  const canPage = !!entry && version === 0;
  const startMoreStyles = () => {
    api()
      .designMoreStyles(threadId)
      .then((names) => {
        setNotice({ text: `Building ${names.join(", ")} beside this design.` });
        stopPicking();
        setCompare(false);
        chooseBoard(true);
      })
      .catch((err: unknown) => setNotice({ text: ipcError(err), error: true }));
  };
  const reloadCanvas = () => void edits.flush().then(() => setManual((n) => n + 1));
  const toggleBoard = () => {
    if (!board) {
      stopPicking();
      setCompare(false);
    }
    chooseBoard(!board);
  };
  const toggleCompare = () => {
    if (!comparing) stopPicking();
    setVersion(0);
    setCompare(!comparing);
  };
  const exportItems: StudioMenuItem[] = [
    ...(entry ? [{ kind: "item" as const, id: "build", label: "Build in codebase", sub: hasHandoff ? "A chat thread builds it" : "Writes the handoff first", disabled: agentRunning, onSelect: () => void buildInCode() }, { kind: "sep" as const, id: "s-build" }] : []),
    { kind: "item", id: "html", label: "HTML", sub: "One file, works offline", onSelect: () => void runExport("html") },
    { kind: "item", id: "png", label: "PNG", sub: `Full page, ${exportWidth} wide`, onSelect: () => void runExport("png") },
    { kind: "item", id: "pdf", label: "PDF", sub: "Slides print one per page", onSelect: () => void runExport("pdf") },
  ];
  const moreItems: StudioMenuItem[] = [
    ...(canPage
      ? [
          { kind: "item" as const, id: "styles", label: "Compare 3 other styles", disabled: agentRunning, onSelect: startMoreStyles },
          ...(cells.length > 0 ? [{ kind: "item" as const, id: "options", label: "Compare options", checked: comparing, onSelect: toggleCompare }] : []),
          { kind: "item" as const, id: "lint", label: "Check design quality", sub: detect === "busy" ? "Checking…" : detect ? `${detect.pins.length} marked` : undefined, checked: detect !== null, disabled: !onPage || detect === "busy", onSelect: toggleDetect },
          ...(versions.length > 0 ? [{ kind: "item" as const, id: "versions", label: "Version history", onSelect: () => setVersionPill(true) }] : []),
          { kind: "sep" as const, id: "s1" },
        ]
      : []),
    { kind: "item", id: "grid", label: "Show 8px grid", shortcut: "⌘'", checked: grid, disabled: !entry, onSelect: () => setGrid(!grid) },
    { kind: "item", id: "reload", label: "Reload canvas", disabled: !entry, onSelect: reloadCanvas },
    { kind: "item", id: "folder", label: "Open design folder", onSelect: () => void api().designReveal(threadId) },
    { kind: "sep", id: "s2" },
    { kind: "item", id: "layout", label: canvasFirst ? "Switch to split chat layout" : "Switch to canvas-first layout", onSelect: () => setPaneLayout({ designLayout: canvasFirst ? "split" : "canvas" }, true) },
    ...(canvasFirst
      ? [
          { kind: "item" as const, id: "changes", label: "Developer: Git changes", shortcut: "⌘⇧D", onSelect: () => useStore.getState().showInspector("changes") },
          { kind: "item" as const, id: "browser", label: "Developer: Browser", shortcut: "⌘⇧B", onSelect: () => useStore.getState().showInspector("browser") },
          { kind: "item" as const, id: "terminal", label: "Developer: Terminal", shortcut: "⌃`", onSelect: () => useStore.getState().toggleTerminal() },
        ]
      : []),
  ];
  const showVersionPill = versionPicker && (versionPill || version !== 0);
  const studioBar = (
    <StudioBar
      title={canvasFirst ? (thread?.title ?? "Design") : null}
      page={
        board && version === 0 ? (
          <span className="studio-page">Board · {entry?.pages.length} pages</span>
        ) : entry && options.length > 1 && !comparing ? (
          <span className="studio-page">
            <Select<string>
              value={entry.rel}
              options={options}
              onChange={(next) => {
                setVersion(0);
                scroll.current = { x: 0, y: 0 };
                setPage(next);
              }}
              ariaLabel="Page"
              className="ghost-select"
            />
          </span>
        ) : (
          <span className="studio-page" title={path ?? undefined}>
            {comparing ? `Comparing ${cells.length}` : (entry?.rel ?? "")}
          </span>
        )
      }
      save={
        onPage && edits.status ? (
          <span className={`design-save-status${edits.status.save === "not-saved" ? " error" : ""}`} role="status" title={edits.status.save === "not-saved" ? "Not saved" : edits.status.save === "saving" ? "Saving…" : "Saved"}>
            <span className="design-save-dot" aria-hidden />
            <span className="studio-save-label">{edits.status.save === "not-saved" ? "Not saved" : edits.status.save === "saving" ? "Saving…" : "Saved"}</span>
          </span>
        ) : null
      }
      version={showVersionPill ? versionPicker : null}
      hasPage={!!entry}
      rail={canvasFirst ? { open: railWanted, onToggle: toggleRail } : null}
      view={view}
      onView={changeView}
      viewport={viewport}
      onViewport={setViewport}
      viewportItems={viewportMenu({
        viewport,
        zoom,
        device,
        deviceOk: deviceFor(viewport) !== null && !board && !comparing,
        board: { can: !!entry && entry.pages.length > 1 && version === 0, on: board, onToggle: toggleBoard },
        flow: board && version === 0 ? { on: flow, onToggle: () => setFlow(!flow) } : null,
        onViewport: setViewport,
        onZoom: setZoom,
        onDevice: () => setDevice(!device),
      })}
      customize={{ open: inspectorOpen && view === "design", disabled: view !== "design" || !onPage, onToggle: () => setInspectorOpen(!inspectorOpen) }}
      exportItems={exportItems}
      exporting={exporting}
      moreItems={moreItems}
    />
  );
  const head = (
    <div className="design-canvas-head drag studio-bar" ref={headRef}>
      {studioBar}
    </div>
  );

  return (
    <section className="design-canvas" aria-label="Design canvas" ref={canvasRef}>
      {/* Canvas-first: in the main header (only the head remounts on a layout switch; the frames never do). */}
      {canvasFirst && headSlot ? createPortal(head, headSlot) : head}
      <div className="design-workspace">
      {rail}
      <div className="design-column">
      {pickersBelow && (viewportPicker || zoomPicker || versionPicker) && (
        <div className="design-canvas-pickers">
          {viewportPicker}
          {zoomPicker}
          {versionPicker}
        </div>
      )}
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
      {edits.status?.save === "not-saved" && (
        <div className="design-version-bar error" role="alert">
          <span>Not saved. Your edits are kept and will be written when saving works again.</span>
          <button className="button ghost" onClick={() => void edits.flush()}>
            Retry
          </button>
        </div>
      )}
      {edits.banner?.kind === "conflict" && (
        <div className="design-version-bar error" role="alert">
          <span title={edits.banner.text}>{edits.banner.text}</span>
          {edits.banner.retry && (
            <button className="button ghost" onClick={edits.reapply}>
              Reapply on latest
            </button>
          )}
          <button className="button ghost" onClick={edits.discard}>
            Discard my edit
          </button>
        </div>
      )}
      {edits.banner?.kind === "boundary" && (
        <div className="design-version-bar" role="alert">
          <span>The next undo goes back past a change made outside the editor.</span>
          <button className="button ghost" onClick={edits.undoPastBoundary}>
            Undo anyway
          </button>
          <button className="button ghost" onClick={edits.dismiss}>
            Keep it
          </button>
        </div>
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
      <div className="design-body">
      {board && entry && version === 0 ? (
        <Board
          pages={entry.pages}
          links={entry.links}
          flow={flow}
          changes={change}
          manual={manual}
          labelOf={labelOf}
          writing={writing}
          onFocus={(rel) => {
            chooseBoard(false);
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
          <div className="design-stage-wrap" ref={wrapRef}>
            {stageEl}
            {cycler}
            {studioLayer}
          </div>
          {inspectorOpen && view === "design" && (
            <CustomizePanel
              threadId={threadId}
              designDir={entry.dir}
              pageRel={entry.rel}
              reloadKey={`${reload}-${manual}`}
              element={one}
              selection={selected}
              parts={kitParts}
              onDeselect={(el) => {
                const rest = selected.filter((s) => s.selector !== el.selector);
                fromFrame.current = "";
                post({ type: "set-selection", targets: rest.map(({ id, selector, tag, text }) => ({ id, selector, tag, text })) });
              }}
              onWrap={wrapSelection}
              onCode={(el) => void openCodeAt(el)}
              onSwitchStyle={() => useStore.getState().requestStudio({ threadId, picker: true })}
              overrides={Object.keys(pageInline).length}
              onSaveTheme={() => setNaming({ kind: "theme", warnings: [], error: null, busy: false })}
              readOnly={agentRunning || edits.status?.readOnly === true}
              styleName={styleName ?? null}
              styleNote={styleNote}
              theme={pageTheme}
              appearance={appearance ?? pageScheme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")}
              onAppearance={setAppearance}
              onClear={clearSelection}
              onViewHtml={() => (one ? void openCodeAt(one) : changeView("code"))}
              tweaks={
                showTweaks ? (
                  <div className="design-tweaks">
                    <TweaksBody tweaks={tweaks.list} values={tweakValues} dirty={tweaksDirty} keeping={keeping} onChange={changeTweak} onReset={resetTweaks} onKeep={() => void keepTweaks()} />
                  </div>
                ) : null
              }
              handlers={{
                onStyle: styleElement,
                onAttr: (el, name, value) => {
                  post({ type: "apply-attr", target: { ...(el.id ? { id: el.id } : {}), selector: el.selector, tag: el.tag, text: "" }, name, value });
                  const to = el.id ? { id: el.id } : el.at ? { locator: { tag: el.tag, path: el.at } } : null;
                  if (to) edits.sendSoon(`${el.selector}:${name}`, to, { kind: "setProp", name, value });
                },
                // The page reads its own text and reports the edit back, so the service gets it exactly as it stands.
                onText: (el, value) => post({ type: "apply-text", target: { ...(el.id ? { id: el.id } : {}), selector: el.selector, tag: el.tag, text: "" }, value }),
                onAttrs: applyAttrs,
                onRetag: retagElement,
              }}
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
      {view === "preview" && presentFrom && entry && (
        <button className="button ghost studio-present" title={board ? "Present from the first screen" : "Present this page"} onClick={() => setPresent(presentFrom)}>
          <Play size={14} strokeWidth={1.75} aria-hidden />
          Present
        </button>
      )}
      {view === "code" && entry && <CodeView threadId={threadId} designDir={entry.dir} page={entry.rel} reloadKey={`${reload}-${manual}`} line={codeLine} />}
      {view === "system" && entry && (
        <section className="studio-system" aria-label="System">
          <SystemMode key={systemStart ?? ""} threadId={threadId} pageUrl={entry.url} pageRel={entry.rel} reloadKey={`${reload}-${manual}`} startUi={systemStart} />
          {stepToast}
        </section>
      )}
      </div>
      </div>
      </div>
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
