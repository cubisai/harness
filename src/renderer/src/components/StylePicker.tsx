import { Check, ChevronDown, Download, Search, Shapes } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AUTO_SYSTEM, parseReferenceSystemId, REFERENCE_SYSTEM_PREFIX, STYLE_PREFIX, type DesignDirection } from "../../../shared/direction";
import type { DesignReferenceCard } from "../../../shared/design-mutation";
import { stylePreviewUrl } from "../../../shared/style-preview";
import type { DesignEntry, DesignKitGroup, DesignMigrationPreview, DesignThemeCard, Thread } from "../../../shared/types";
import { api } from "../api";
import { StudioMenu, type StudioMenuItem } from "../design/StudioBar";
import { isDark, useStore } from "../store";
import { facetLabel } from "./DesignSystemMenu";

const FOUNDATION = "foundation";

/** The IPC error's own words, with Electron's wrapper off. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
}

/** How many reference cards the grid adds at a time as it scrolls. */
const REFERENCE_PAGE = 48;

/** The card a thread's system shows as: a flat library style is a Foundation theme under the same name, and a reference is `ref:<slug>`. */
export function cardIdOf(value: string | undefined, direction?: DesignDirection | null): string | null {
  const ref = value === AUTO_SYSTEM ? direction?.reference : parseReferenceSystemId(value);
  if (ref) return `${REFERENCE_SYSTEM_PREFIX}${ref.slug}`;
  const id = value === AUTO_SYSTEM ? direction?.style : value;
  if (!id) return null;
  return id.startsWith(STYLE_PREFIX) ? `kit:${FOUNDATION}/${id.slice(STYLE_PREFIX.length)}` : id;
}

/** The kit a system belongs to. Anything with no kit counts as Foundation, whose themes the flat styles are. */
export function groupOfCard(groups: readonly DesignKitGroup[], id: string | null): DesignKitGroup | undefined {
  return (id ? groups.find((g) => g.themes.some((t) => t.id === id)) : undefined) ?? groups.find((g) => g.id === FOUNDATION) ?? groups[0];
}

/** Search by feel as well as by name: facets are words too (`dark`, `serif`, `sharp`). Every word has to match. */
export function filterCards(cards: readonly DesignThemeCard[], query: string): DesignThemeCard[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...cards];
  return cards.filter((c) => {
    const f = c.facets;
    const hay = `${c.name} ${c.description} ${f ? `${f.theme} ${f.display} ${f.shape}` : ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Search references by name, look, industry, site and colour names. Every word has to match. */
export function filterReferences(refs: readonly DesignReferenceCard[], query: string, theme: "all" | "light" | "dark", industry: string | null): DesignReferenceCard[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return refs.filter((r) => {
    if (theme === "dark" ? r.theme !== "dark" : theme === "light" ? r.theme === "dark" : false) return false;
    if (industry && r.industry !== industry) return false;
    if (!words.length) return true;
    const hay = `${r.name} ${r.nickname} ${r.industry} ${r.host} ${r.theme} ${r.colors.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A reference drawn as a theme card: its index colours on a miniature stage. */
function referenceThemeCard(r: DesignReferenceCard): DesignThemeCard {
  return { id: r.id, name: r.name, description: r.nickname, swatches: [], card: r.card, mine: false };
}

/** "acme-labs" -> "Acme Labs", for a reference whose card isn't loaded. */
function slugName(slug: string): string {
  return slug.split("-").map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}

/** What the chip says: Auto with what it picked, or the kit and its theme. A kit's own default theme is just the kit. */
export function chipLabel(groups: readonly DesignKitGroup[], value: string | undefined, direction?: DesignDirection | null, refs: readonly { id: string; name: string }[] = []): { name: string; title: string } {
  const id = cardIdOf(value, direction);
  if (id?.startsWith(REFERENCE_SYSTEM_PREFIX)) {
    const ref = refs.find((r) => r.id === id)?.name ?? slugName(id.slice(REFERENCE_SYSTEM_PREFIX.length));
    return value === AUTO_SYSTEM ? { name: `Auto · ${ref}`, title: `Style: Auto, picked the ${ref} reference for this brief` } : { name: ref, title: `Style: ${ref} (design reference)` };
  }
  const group = id ? groups.find((g) => g.themes.some((t) => t.id === id)) : undefined;
  const theme = group?.themes.find((t) => t.id === id);
  if (value === AUTO_SYSTEM || !value) {
    return theme ? { name: `Auto · ${theme.name}`, title: `Style: Auto, picked ${theme.name} for this brief` } : { name: "Auto", title: "Style: Auto (picks one that fits the brief)" };
  }
  if (!group || !theme) return { name: value === "project" ? "Project" : "Style", title: "Style" };
  const name = group.id === FOUNDATION || theme.name === group.name || theme.mine ? theme.name : `${group.name} · ${theme.name}`;
  return { name, title: `Style: ${name}` };
}

/** A list that can run to dozens, cut to what fits in a sentence. */
function shortList(items: { name: string; count: number }[], max = 6): string {
  const shown = items.slice(0, max).map((u) => `${u.name} (${u.count})`).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** One theme as a miniature of itself: its own ground, type, button and corners. */
function ThemeCard({ card, dark, selected, previewing, badge, onHover, onClick, onDouble }: { card: DesignThemeCard; dark: boolean; selected: boolean; previewing: boolean; badge?: string; onHover: () => void; onClick: () => void; onDouble: () => void }) {
  const look = dark && card.card.dark ? { ...card.card, ...card.card.dark } : card.card;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-id={card.id}
      className={`sp-card${selected ? " selected" : ""}${previewing ? " previewing" : ""}`}
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onClick}
      onDoubleClick={onDouble}
    >
      <span className="sp-stage" aria-hidden style={{ background: look.bg, color: look.text, borderColor: look.border }}>
        <span className="sp-stage-top">
          <span className="sp-aa" style={{ fontFamily: look.font }}>
            Aa
          </span>
          <span className="sp-dots">
            {[look.accent, look.text, look.muted, look.surface].map((c, i) => (
              <span key={i} style={{ background: c, borderColor: look.border }} />
            ))}
          </span>
        </span>
        <span className="sp-stage-ui">
          <span className="sp-mini-button" style={{ background: look.accent, color: look.onAccent, borderRadius: look.radius }}>
            Button
          </span>
          <span className="sp-mini-card" style={{ background: look.surface, borderColor: look.border, borderRadius: look.radius }} />
        </span>
      </span>
      <span className="sp-card-meta">
        <span className="sp-card-name" title={card.name}>
          {card.name}
        </span>
        {selected ? <Check size={13} className="sp-card-check" aria-hidden /> : badge ? <span className="sp-card-badge">{badge}</span> : card.mine ? <span className="sp-card-badge">Yours</span> : null}
      </span>
    </button>
  );
}

/** A frame showing a whole page, scaled to its box: nothing in it can be clicked. */
function ScaledFrame({ title, url }: { title: string; url: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const resize = () => setScale(el.clientWidth / 1440);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="sp-move-frame" ref={box}>
      <iframe title={title} sandbox="allow-scripts" tabIndex={-1} src={url} style={{ transform: `scale(${scale})` }} />
    </div>
  );
}

/** The width a style's sample page is laid out at: a desktop page, scaled down to whatever box the picker has. */
const SPECIMEN_WIDTH = 960;

/** A style's sample page, always laid out at desktop width and scaled to fit its box. */
function Specimen({ title, url }: { title: string; url: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ scale: 0.375, height: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const resize = () => {
      const scale = el.clientWidth / SPECIMEN_WIDTH || 0.375;
      setSize({ scale, height: el.clientHeight / scale });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="sp-specimen" ref={box}>
      <iframe title={title} sandbox="" tabIndex={-1} src={url} style={{ width: SPECIMEN_WIDTH, height: size.height || undefined, transform: `scale(${size.scale})` }} />
    </div>
  );
}

/** What a move to another kit would do, side by side, before anything changes. */
function KitMovePreview({ preview, entry, busy, onCancel, onCommit }: { preview: DesignMigrationPreview; entry: DesignEntry; busy: boolean; onCancel: () => void; onCommit: () => void }) {
  const after = new URL(preview.previewRel, entry.url).toString();
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => go.current?.focus(), []);
  return createPortal(
    <div
      className="sheet-backdrop sp-move-backdrop"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="sp-move" role="dialog" aria-modal="true" aria-label={`Adapt page to ${preview.targetName}`}>
        <h2 className="sp-move-title">Adapt page to {preview.targetName}</h2>
        <div className="sp-move-frames">
          <figure>
            <figcaption>Now</figcaption>
            <ScaledFrame title="The page now" url={entry.url} />
          </figure>
          <figure>
            <figcaption>After</figcaption>
            <ScaledFrame title="The page after the move" url={after} />
          </figure>
        </div>
        <ul className="sp-move-list">
          <li>
            {preview.same + preview.renamed.reduce((n, r) => n + r.count, 0)} parts move to this kit
            {preview.pages > 1 ? `, on all ${preview.pages} pages` : ""}.
          </li>
          {preview.unsupported.length > 0 && <li className="warn">Stay as written, with no match in this kit: {shortList(preview.unsupported)}.</li>}
          {preview.review.length > 0 && <li className="warn">Built differently here, worth a look: {shortList(preview.review)}.</li>}
          {preview.droppedProps.length > 0 && <li>Fall back to the default: {[...new Set(preview.droppedProps.map((d) => `${d.prop} ${d.value}`))].slice(0, 6).join(", ")}.</li>}
        </ul>
        <div className="sp-move-actions">
          <span className="sp-move-hint">One undo step. To rebuild what didn't move, ask in the chat afterwards.</span>
          <button type="button" className="button ghost" onClick={onCancel}>
            Cancel
          </button>
          <button ref={go} type="button" className="button primary" disabled={busy} onClick={onCommit}>
            {busy ? "Adapting…" : "Adapt page"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The groups seen last per project, so a remounted chip doesn't blink a wrong name while it re-reads. */
const lastGroups = new Map<string | null, DesignKitGroup[]>();
/** The downloaded references seen last (the same for every project); null before the first read. */
let lastRefs: DesignReferenceCard[] | null = null;

/**
 * Design v2's style picker: the current kit's themes as cards, and a `Kit:` menu for the others. A theme of this kit
 * swaps tokens at once; one from another kit opens a side-by-side preview first, because that moves the page.
 */
export function StylePicker({ projectId, thread, value, direction, disabled, onDraftPick }: { projectId: string | null; thread: Thread | null; value: string | undefined; direction?: DesignDirection | null; disabled?: boolean; onDraftPick?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<DesignKitGroup[]>(() => lastGroups.get(projectId) ?? []);
  const [kitId, setKitId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dark, setDark] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kit: string; kind: "preparing" | "failed"; message?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [move, setMove] = useState<{ preview: DesignMigrationPreview; entry: DesignEntry } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refs, setRefs] = useState<DesignReferenceCard[] | null>(lastRefs);
  const [refTheme, setRefTheme] = useState<"all" | "light" | "dark">("all");
  const [industry, setIndustry] = useState<string | null>(null);
  const [shown, setShown] = useState(REFERENCE_PAGE);
  const more = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const preparing = useRef(0);

  const load = useCallback(() => {
    void api()
      .designKitGroups(projectId)
      .then((list) => {
        lastGroups.set(projectId, list);
        setGroups(list);
      })
      .catch(() => {});
  }, [projectId]);
  useEffect(load, [load, value, open]);
  // References: read on mount for the chip's name, and again each time the picker opens (a download may have landed).
  useEffect(() => {
    if (lastRefs && !open) return;
    void api()
      .designReferenceCards()
      .then((list) => {
        lastRefs = list;
        setRefs(list);
      })
      .catch(() => {});
  }, [open]);
  useEffect(() => setShown(REFERENCE_PAGE), [query, refTheme, industry, kitId]);

  const currentId = cardIdOf(value, direction);
  const activeGroup = groupOfCard(groups, currentId);
  const group = groups.find((g) => g.id === kitId) ?? activeGroup;
  const sameKit = group?.id === activeGroup?.id;
  const auto = value === AUTO_SYSTEM || !value;
  const cards = useMemo(() => filterCards(group?.themes ?? [], query), [group, query]);
  const foundation = group?.id === FOUNDATION;
  const refMatches = useMemo(() => (foundation && refs ? filterReferences(refs, query, refTheme, industry) : []), [foundation, refs, query, refTheme, industry]);
  const refCards = useMemo(() => refMatches.slice(0, shown).map(referenceThemeCard), [refMatches, shown]);
  const findCard = (id: string | null | undefined): DesignThemeCard | undefined => {
    if (!id) return undefined;
    if (id.startsWith(REFERENCE_SYSTEM_PREFIX)) {
      const r = refs?.find((x) => x.id === id);
      return r ? referenceThemeCard(r) : undefined;
    }
    return cards.find((c) => c.id === id) ?? (group?.themes ?? []).find((c) => c.id === id);
  };
  // The current reference stays previewable even when the filter hides it.
  const preview = findCard(previewId) ?? (foundation || !currentId?.startsWith(REFERENCE_SYSTEM_PREFIX) ? findCard(currentId) : undefined) ?? cards[0] ?? refCards[0];
  const previewRef = preview?.id.startsWith(REFERENCE_SYSTEM_PREFIX) ? refs?.find((r) => r.id === preview.id) : undefined;
  const industries = useMemo(() => [...new Set((refs ?? []).map((r) => r.industry))].sort((a, b) => (a === "other" ? 1 : b === "other" ? -1 : a.localeCompare(b))), [refs]);
  const label = chipLabel(groups, value, direction, refs ?? []);

  // The grid grows by a page as its end scrolls into view: 1,295 cards never render at once.
  useEffect(() => {
    const el = more.current;
    if (!open || !el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => n + REFERENCE_PAGE);
    }, { root: grid.current, rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, refCards.length, refMatches.length]);
  const request = useStore((s) => s.studioRequest);
  const clearRequest = useStore((s) => s.requestStudio);

  const close = useCallback((back = true) => {
    setOpen(false);
    setNaming(null);
    setError(null);
    setStatus(null);
    preparing.current += 1;
    if (back) chip.current?.focus();
  }, []);

  const openPicker = useCallback(() => {
    // The first time with nothing downloaded, the references sheet asks first (once, either answer).
    if (!useStore.getState().settings?.designReferencesAsked && lastRefs !== null && lastRefs.length === 0) {
      useStore.getState().setReferencesSheetOpen(true);
      return;
    }
    setKitId(null);
    setQuery("");
    setPreviewId(null);
    setDark(isDark());
    // Sits just above the Composer, flush with its left edge, so it never covers the text box.
    const r = (chip.current?.closest(".composer") ?? chip.current)?.getBoundingClientRect();
    if (r) {
      // The Composer's own width; a narrow Composer gets a 640px picker centred over it.
      const width = Math.min(Math.max(r.width, 640), window.innerWidth - 32);
      const left = r.left + (r.width - width) / 2;
      setPlace({ left: Math.max(16, Math.min(left, window.innerWidth - width - 16)), bottom: window.innerHeight - r.top + 8, width });
    }
    setOpen(true);
  }, []);

  // Page Theme's `Switch style…` opens this from across the app.
  useEffect(() => {
    if (!request || !thread || request.threadId !== thread.id || !request.picker) return;
    clearRequest(null);
    openPicker();
  }, [request, thread, clearRequest, openPicker]);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !chip.current?.contains(t)) close(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, close]);

  const pickKit = async (id: string) => {
    setPreviewId(null);
    setError(null);
    setKitId(id);
    const target = groups.find((g) => g.id === id);
    if (!target || target.installed) {
      setStatus(null);
      return;
    }
    const run = ++preparing.current;
    setStatus({ kit: id, kind: "preparing" });
    const done = await api()
      .designKitEnsure(id)
      .catch((err: unknown) => ({ ok: false as const, code: "offline" as const, message: errorText(err) }));
    if (run !== preparing.current) return;
    if (done.ok) {
      setStatus(null);
      load();
    } else {
      setStatus({ kit: id, kind: "failed", message: done.code === "offline" ? "Unavailable offline" : done.message });
    }
  };

  const applied = (text: string, undo: () => Promise<unknown>) => {
    if (thread) useStore.getState().setSystemStep(thread.id, { text, undo });
  };

  const apply = async (card: DesignThemeCard) => {
    setError(null);
    if (!thread) {
      onDraftPick?.(card.id);
      close();
      return;
    }
    setBusy(true);
    try {
      if (sameKit) {
        if (card.id !== currentId || auto) {
          const res = await api().designApplyTheme(thread.id, card.id);
          const previous = res.previous;
          applied(`Theme → ${card.name}`, () => (previous && previous !== AUTO_SYSTEM ? api().designApplyTheme(thread.id, previous) : api().setDesignSystem(thread.id, null)));
        }
        close();
        return;
      }
      const entry = await api().designEntry(thread.id);
      if (!entry) {
        await useStore.getState().setDesignSystem(thread.id, card.id);
        close();
        return;
      }
      setMove({ preview: await api().designMigratePreview(thread.id, entry.rel, card.id), entry });
      // The dialog takes over: left open behind it, the picker's click-away ate the first click on Adapt page.
      close(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const pickAuto = () => {
    if (thread) void useStore.getState().setDesignSystem(thread.id, AUTO_SYSTEM);
    else onDraftPick?.(AUTO_SYSTEM);
    close();
  };

  const saveCopy = async () => {
    if (!thread || !preview || naming === null || !naming.trim()) return;
    setBusy(true);
    try {
      const saved = await api().designSaveTheme(thread.id, naming.trim(), {}, preview.id);
      useStore.getState().apply({ type: "thread", thread: saved.thread });
      useStore.getState().requestStudio({ threadId: thread.id, view: "system" });
      close();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const commitMove = async () => {
    if (!thread || !move) return;
    setBusy(true);
    try {
      const { thread: next } = await api().designMigrateCommit(thread.id, move.entry.rel, move.preview.targetId);
      useStore.getState().apply({ type: "thread", thread: next });
      const flagged = move.preview.unsupported.reduce((n, u) => n + u.count, 0) + move.preview.review.reduce((n, u) => n + u.count, 0);
      useStore.getState().setSystemStep(thread.id, { text: `Moved to ${move.preview.targetName}${flagged ? ` · ${flagged} part${flagged === 1 ? "" : "s"} to check` : ""}`, undo: "page" });
      setMove(null);
      close();
    } catch (err) {
      useStore.getState().showNotice(`Couldn't adapt the page: ${errorText(err)}`);
      setMove(null);
    } finally {
      setBusy(false);
    }
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    const list = [...(panel.current?.querySelectorAll<HTMLButtonElement>(".sp-card") ?? [])];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? 2 : e.key === "ArrowUp" ? -2 : 0;
    if (!step || !list.length) return;
    e.preventDefault();
    list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + step))]?.focus();
  };

  const kitItems: StudioMenuItem[] = groups.map((g) => ({
    kind: "item",
    id: g.id,
    label: g.name,
    ...(g.mine ? { sub: "Yours" } : g.installed ? { sub: `${g.components} parts` } : { sub: "Download" }),
    checked: g.id === group?.id,
    onSelect: () => void pickKit(g.id),
  }));
  if (thread) {
    kitItems.push(
      { kind: "sep", id: "s-new" },
      {
        kind: "item",
        id: "new-kit",
        label: "Start a new kit…",
        onSelect: () => {
          useStore.getState().setDesignChip(thread.id, { kind: "new-kit" });
          close();
        },
      },
    );
  }

  const isCurrent = preview?.id === currentId && !auto;
  const facets = previewRef ? [previewRef.industry, previewRef.theme === "mixed" ? "light and dark" : previewRef.theme, previewRef.host].filter(Boolean).join(" · ") : preview?.facets ? facetLabel(preview.facets) : "";
  const refFilter = [refTheme === "all" ? "" : refTheme === "light" ? "Light" : "Dark", industry ?? ""].filter(Boolean).join(" · ");
  const filterItems: StudioMenuItem[] = [
    { kind: "head", id: "h-theme", label: "Theme" },
    ...(["all", "light", "dark"] as const).map((t): StudioMenuItem => ({ kind: "item", id: `t-${t}`, label: t === "all" ? "Any" : t === "light" ? "Light" : "Dark", checked: refTheme === t, keepOpen: true, onSelect: () => setRefTheme(t) })),
    { kind: "sep", id: "s-industry" },
    { kind: "head", id: "h-industry", label: "Industry" },
    { kind: "item", id: "i-any", label: "Any", checked: industry === null, keepOpen: true, onSelect: () => setIndustry(null) },
    ...industries.map((i): StudioMenuItem => ({ kind: "item", id: `i-${i}`, label: i === "ai" ? "AI" : i === "saas" ? "SaaS" : i[0]!.toUpperCase() + i.slice(1), checked: industry === i, keepOpen: true, onSelect: () => setIndustry(i) })),
  ];
  const showing = status?.kit === group?.id ? status : null;

  return (
    <>
      <button
        ref={chip}
        className="chip-button ds-chip"
        title={label.title}
        aria-label={label.title}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : openPicker())}
      >
        <Shapes size={13} />
        <span className="ds-chip-label">{label.name}</span>
        <ChevronDown size={12} className="chev" />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={panel}
            className="sp-picker"
            role="dialog"
            aria-label="Choose a style"
            style={{ left: place.left, bottom: place.bottom, width: place.width }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !e.defaultPrevented) {
                e.stopPropagation();
                if (naming !== null) setNaming(null);
                else close();
              }
            }}
          >
            <div className="sp-top">
              <label className="sp-search">
                <Search size={14} strokeWidth={1.75} aria-hidden />
                <input ref={search} value={query} placeholder="Search by name or feel: clean, serif, dark, sharp…" aria-label="Search styles" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <div className="segmented compact" role="group" aria-label="Preview in">
                <button type="button" className={dark ? "" : "on"} aria-pressed={!dark} onClick={() => setDark(false)}>
                  Light
                </button>
                <button type="button" className={dark ? "on" : ""} aria-pressed={dark} onClick={() => setDark(true)}>
                  Dark
                </button>
              </div>
            </div>
            <div className="sp-kit-row">
              <StudioMenu label="Kit" title="The components your page is built from" align="left" className="button ghost sp-kit-button" text={<>Kit: <strong>{group?.name ?? "…"}</strong><ChevronDown size={12} aria-hidden /></>} items={kitItems} />
              <span className="sp-kit-note">{sameKit ? "Themes for your current kit" : "Another kit: applying one adapts your page"}</span>
            </div>
            <div className="sp-body">
              <div ref={grid} className="sp-grid" role="listbox" aria-label="Themes" onKeyDown={onGridKey}>
                {showing?.kind === "preparing" && (
                  <div className="sp-status" role="status">
                    <span>Preparing style…</span>
                    <span className="sp-progress" aria-hidden />
                    <button type="button" className="button ghost" onClick={() => {
                      preparing.current += 1;
                      setStatus(null);
                      setKitId(null);
                    }}>
                      Cancel
                    </button>
                  </div>
                )}
                {showing?.kind === "failed" && (
                  <div className="sp-status" role="alert">
                    <span>{showing.message}</span>
                    <button type="button" className="button ghost" onClick={() => group && void pickKit(group.id)}>
                      Retry
                    </button>
                  </div>
                )}
                {!showing && group?.id === FOUNDATION && !query.trim() && (
                  <button type="button" role="option" aria-selected={auto} className={`sp-card sp-auto${auto ? " selected" : ""}`} onClick={pickAuto}>
                    <span className="sp-auto-text">
                      <span className="sp-card-name">Auto</span>
                      <span className="sp-auto-desc">Matches your prompt's vibe</span>
                    </span>
                    {auto && <Check size={13} className="sp-card-check" aria-hidden />}
                  </button>
                )}
                {!showing &&
                  cards.map((card) => (
                    <ThemeCard
                      key={card.id}
                      card={card}
                      dark={dark}
                      selected={card.id === currentId && !auto}
                      previewing={card.id === preview?.id}
                      {...(sameKit ? {} : { badge: "Adapts page" })}
                      onHover={() => setPreviewId(card.id)}
                      onClick={() => setPreviewId(card.id)}
                      onDouble={() => void apply(card)}
                    />
                  ))}
                {!showing && foundation && refs && refs.length > 0 && (
                  <div className="sp-section">
                    <span className="sp-section-name">
                      Design references · {refMatches.length.toLocaleString()}
                    </span>
                    <StudioMenu label="Filter" title="Filter design references" align="left" className="button ghost sp-kit-button" text={<>{refFilter || "Filter"}<ChevronDown size={12} aria-hidden /></>} items={filterItems} />
                  </div>
                )}
                {!showing &&
                  refCards.map((card) => (
                    <ThemeCard
                      key={card.id}
                      card={card}
                      dark={dark}
                      selected={card.id === currentId && !auto}
                      previewing={card.id === preview?.id}
                      {...(sameKit ? {} : { badge: "Adapts page" })}
                      onHover={() => setPreviewId(card.id)}
                      onClick={() => setPreviewId(card.id)}
                      onDouble={() => void apply(card)}
                    />
                  ))}
                {!showing && refCards.length < refMatches.length && <div ref={more} className="sp-more" aria-hidden />}
                {!showing && foundation && refs?.length === 0 && !query.trim() && (
                  <button type="button" className="sp-card sp-auto" onClick={() => {
                    close(false);
                    useStore.getState().setReferencesSheetOpen(true);
                  }}>
                    <span className="sp-auto-text">
                      <span className="sp-card-name">Download design references</span>
                      <span className="sp-auto-desc">1,295 real-site styles, about 43 MB</span>
                    </span>
                    <Download size={13} aria-hidden />
                  </button>
                )}
                {!showing && !cards.length && !refCards.length && <p className="sp-empty">{query.trim() ? `No theme in ${group?.name ?? "this kit"} matches "${query.trim()}".` : "This kit has no themes yet."}</p>}
              </div>
              <div className="sp-preview">
                {preview ? (
                  <>
                    <Specimen key={`${preview.id}-${dark}`} title={`${preview.name} sample`} url={stylePreviewUrl(projectId, preview.id, dark ? "dark" : "light")} />
                    <div className="sp-preview-name">{preview.name}</div>
                    {preview.description && <div className="sp-preview-desc">{preview.description}</div>}
                    <div className="sp-preview-facts">
                      {[group && group.components ? `${group.components} parts` : "", facets].filter(Boolean).join(" · ")}
                    </div>
                    {error && (
                      <p className="sp-error" role="alert">
                        {error}
                      </p>
                    )}
                    {naming !== null ? (
                      <form
                        className="sp-name"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveCopy();
                        }}
                      >
                        <input className="text-input" autoFocus value={naming} placeholder="Name your copy" aria-label="Name your copy" maxLength={80} onChange={(e) => setNaming(e.target.value)} />
                        <button type="button" className="button ghost" onClick={() => setNaming(null)}>
                          Cancel
                        </button>
                        <button type="submit" className="button primary" disabled={busy || !naming.trim()}>
                          Save
                        </button>
                      </form>
                    ) : (
                      <div className="sp-foot">
                        {thread && sameKit && (
                          <button type="button" className="button ghost" onClick={() => setNaming(`${preview.name} copy`)}>
                            Customize a copy
                          </button>
                        )}
                        <button type="button" className="button primary" disabled={busy || isCurrent} onClick={() => void apply(preview)}>
                          {isCurrent ? "In use" : !thread ? "Use this style" : sameKit ? (previewRef ? "Apply style" : "Apply theme") : "Adapt page to this style"}
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="sp-empty">Nothing to preview.</p>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
      {move && (
        <KitMovePreview
          preview={move.preview}
          entry={move.entry}
          busy={busy}
          onCancel={() => {
            if (thread) void api().designMigrateCancel(thread.id);
            setMove(null);
          }}
          onCommit={() => void commitMove()}
        />
      )}
    </>
  );
}
