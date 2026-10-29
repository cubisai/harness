import { Check, ChevronDown, ChevronLeft, ChevronRight, Eye, Shapes } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { AUTO_SYSTEM, type DesignDirection } from "../../../shared/direction";
import { stylePreviewUrl } from "../../../shared/style-preview";
import type { DesignSystemOption, StyleFacets, Thread } from "../../../shared/types";
import { api } from "../api";
import { focusOption, focusSelectedOption } from "../option-keys";
import { isDark, useStore } from "../store";

/** The system a thread uses when it names none (or one that's gone): the project's own, else none (never a stand-in palette). */
export function shownSystem(options: DesignSystemOption[], id: string | undefined): DesignSystemOption | undefined {
  return (id ? options.find((o) => o.id === id) : undefined) ?? options.find((o) => o.id === "project");
}

/** The style a thread's design is drawn in, by name (the board's `Page · Style` labels): Auto's pick, else the fixed system. */
export function designStyleName(options: DesignSystemOption[], value: string | undefined, direction?: DesignDirection | null): string | undefined {
  if (value === AUTO_SYSTEM) return direction ? options.find((o) => o.id === direction.style)?.name : undefined;
  return shownSystem(options, value)?.name;
}

const lastOptions = new Map<string | null, DesignSystemOption[]>();

/**
 * The design systems a project's threads can pick from. Re-read on open too: a system the agent just extracted into
 * .agents/design-systems shows up without a restart. And when the value changes: the System tab's first edit switches
 * the thread to a copy that wasn't in the list yet.
 */
export function useDesignSystemOptions(projectId: string | null, open: boolean, value: string | undefined): DesignSystemOption[] {
  // The last list per project seeds a remounted chip, so it doesn't blink empty (and resize the bar) while it re-reads.
  const [options, setOptions] = useState<DesignSystemOption[]>(() => lastOptions.get(projectId) ?? []);
  useEffect(() => {
    let live = true;
    void api()
      .designSystems(projectId)
      .then((list) => {
        lastOptions.set(projectId, list);
        if (live) setOptions(list);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, open, value]);
  return options;
}

/** The menu's Auto entry: the agent picks a style per brief. */
export const AUTO_OPTION: DesignSystemOption = {
  id: AUTO_SYSTEM,
  name: "Auto",
  description: "Picks a style that fits each brief; your project's own DESIGN.md still wins",
  swatches: [],
  source: "project",
};

/**
 * What the style chip shows: Auto (with the style its agent chose, once it has) or the fixed style, by name only. A
 * value with nothing picked (a draft, or a thread from before Auto) is Auto, as a new design thread starts on it.
 */
export function chipStyle(options: DesignSystemOption[], value: string | undefined, direction?: DesignDirection | null): { id: string; name: string; title: string } {
  const fixed = value && value !== AUTO_SYSTEM ? options.find((o) => o.id === value) : undefined;
  if (fixed) return { id: fixed.id, name: fixed.name, title: `Style: ${fixed.name}` };
  const picked = direction ? options.find((o) => o.id === direction.style) : undefined;
  return picked
    ? { id: AUTO_SYSTEM, name: `Auto · ${picked.name}`, title: `Style: Auto, picked ${picked.name} for this brief` }
    : { id: AUTO_SYSTEM, name: "Auto", title: "Style: Auto (picks one that fits the brief)" };
}

/** The menu's sections: Auto, then the project's own systems, then the style library. */
export function styleGroups(options: DesignSystemOption[]): { label: string; options: DesignSystemOption[] }[] {
  const systems = options.filter((o) => o.source !== "style");
  const styles = options.filter((o) => o.source === "style");
  return [
    { label: "", options: [AUTO_OPTION] },
    ...(systems.length ? [{ label: "Project", options: systems }] : []),
    ...(styles.length ? [{ label: "Styles", options: styles }] : []),
  ];
}

/** One filter dimension pair for the style list: null means any. */
export interface StyleFilter {
  theme: "light" | "dark" | null;
  display: "serif" | "sans" | "mono" | null;
}

/** The options a filter keeps: project systems always, styles only when their facets match. */
export function filterStyles(options: DesignSystemOption[], filter: StyleFilter): DesignSystemOption[] {
  return options.filter(
    (o) =>
      o.source !== "style" ||
      ((filter.theme === null || o.facets?.theme === filter.theme) && (filter.display === null || o.facets?.display === filter.display)),
  );
}

/** The styles with a sample page, in menu order: Auto and facet-less systems are left out. */
export function previewable(options: DesignSystemOption[]): DesignSystemOption[] {
  return options.filter((o) => o.id !== AUTO_SYSTEM && o.facets);
}

/** The id `delta` places from `id` in `list`, wrapping; `id` itself when it isn't listed. */
export function stepPreview(list: DesignSystemOption[], id: string, delta: 1 | -1): string {
  const index = list.findIndex((o) => o.id === id);
  if (index < 0 || list.length === 0) return id;
  return list[(index + delta + list.length) % list.length]?.id ?? id;
}

/** A style's facets in one line: "Light + dark · Sans type · Sharp corners". */
export function facetLabel(f: StyleFacets): string {
  const theme = f.theme === "dark" ? "Dark" : "Light";
  const display = f.display === "serif" ? "Serif" : f.display === "mono" ? "Mono" : "Sans";
  const shape = f.shape === "sharp" ? "Sharp" : f.shape === "round" ? "Round" : "Soft";
  return `${theme}${f.darkPair ? " + dark" : ""} · ${display} type · ${shape} corners`;
}

/** The theme a preview opens in: the app's own when the style has a dark pair, else the style's base. */
export function initialPreviewTheme(f: StyleFacets, appDark: boolean): "light" | "dark" {
  return f.darkPair ? (appDark ? "dark" : "light") : f.theme;
}

/** The filter the pills were last left on, so a remounted menu keeps it. */
let lastFilter: StyleFilter = { theme: null, display: null };

/**
 * A design thread's style chip, beside the fence chip: Auto until the user picks a style. Names only: the colours are
 * the style's own unless the prompt names some (the guide's "the brief wins"), so the menu shows no palette.
 */
export function DesignStyleMenu({
  projectId,
  value,
  direction,
  disabled,
  onPick,
}: {
  projectId: string | null;
  value: string | undefined;
  direction?: DesignDirection | null;
  disabled?: boolean;
  onPick(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const options = useDesignSystemOptions(projectId, open, value);
  const [filter, setFilter] = useState<StyleFilter>(() => lastFilter);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewTheme, setPreviewTheme] = useState<"light" | "dark">("light");
  const [scale, setScale] = useState(0.4);
  const [focusBack, setFocusBack] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const frameBox = useRef<HTMLDivElement>(null);
  const useButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) focusSelectedOption(menu.current);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setOpen(false);
        setPreviewId(null);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  // The sample page is a fixed 960x600 layout; the box scales it to fit instead of cropping it.
  useEffect(() => {
    if (!previewId || typeof ResizeObserver === "undefined") return;
    const frame = frameBox.current;
    if (!frame) return;
    const resize = () => setScale(frame.clientWidth / 960);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [previewId]);
  // A preview opens on its action; the Use button, or Next when the style is already in use.
  useEffect(() => {
    if (!previewId) return;
    const target = useButton.current && !useButton.current.disabled ? useButton.current : nextButton.current;
    target?.focus();
  }, [previewId]);
  // Back and Escape put focus back on the row the preview came from.
  useEffect(() => {
    if (!open || previewId || !focusBack) return;
    menu.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusBack)}"]`)?.focus();
    setFocusBack(null);
  }, [open, previewId, focusBack]);

  function changeFilter(next: StyleFilter) {
    lastFilter = next;
    setFilter(next);
  }

  function openPreview(id: string) {
    const o = options.find((x) => x.id === id);
    if (!o?.facets) return;
    setPreviewTheme(initialPreviewTheme(o.facets, isDark()));
    setPreviewId(id);
  }

  function pick(id: string) {
    setOpen(false);
    setPreviewId(null);
    chip.current?.focus();
    if (id !== current.id) onPick(id);
  }

  function back() {
    if (previewId) setFocusBack(previewId);
    setPreviewId(null);
  }

  function step(delta: 1 | -1) {
    if (!previewId) return;
    const next = options.find((x) => x.id === stepPreview(list, previewId, delta));
    if (!next?.facets) return;
    setPreviewTheme(initialPreviewTheme(next.facets, isDark()));
    setPreviewId(next.id);
  }

  const current = chipStyle(options, value, direction);
  const shown = filterStyles(options, filter);
  const list = previewable(shown);
  const preview = previewId ? options.find((o) => o.id === previewId && o.facets) : undefined;
  const index = preview ? list.findIndex((o) => o.id === preview.id) : -1;
  const hasFacets = options.some((o) => o.facets);
  return (
    <div
      className="model-picker"
      ref={box}
      onKeyDown={(e) => {
        if (!open) {
          // Arrow Down/Up on the chip opens the menu, like a select.
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }
          return;
        }
        if (preview) {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setFocusBack(preview.id);
            setPreviewId(null);
            return;
          }
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            step(e.key === "ArrowLeft" ? -1 : 1);
            return;
          }
          return;
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
          setPreviewId(null);
          chip.current?.focus();
          return;
        }
        if (e.key === "ArrowRight") {
          const id = (document.activeElement as HTMLElement | null)?.dataset.id;
          const o = id ? options.find((x) => x.id === id) : undefined;
          if (o?.facets) {
            e.preventDefault();
            e.stopPropagation();
            openPreview(o.id);
            return;
          }
        }
        focusOption(e, menu.current);
      }}
    >
      <button
        ref={chip}
        className="chip-button ds-chip"
        title={current.title}
        aria-label={current.title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) setPreviewId(null);
          setOpen((o) => !o);
        }}
      >
        <Shapes size={13} />
        <span className="ds-chip-label">{current.name}</span>
        <ChevronDown size={12} className="chev" />
      </button>
      {open && (
        <div
          ref={menu}
          className={`model-menu up ds-menu${preview ? " previewing" : ""}`}
          role={preview ? "dialog" : "listbox"}
          aria-label={preview ? `Preview ${preview.name}` : "Style"}
        >
          {preview ? (
            <div className="ds-preview">
              <div className="ds-preview-head">
                <button type="button" className="button ghost ds-back" onClick={back}>
                  <ChevronLeft size={13} />
                  Styles
                </button>
                <span className="ds-preview-count">
                  {Math.max(index + 1, 1)} / {Math.max(list.length, 1)}
                </span>
                <button type="button" className="icon-button" aria-label="Previous style" onClick={() => step(-1)} disabled={list.length < 2}>
                  <ChevronLeft size={14} />
                </button>
                <button ref={nextButton} type="button" className="icon-button" aria-label="Next style" onClick={() => step(1)} disabled={list.length < 2}>
                  <ChevronRight size={14} />
                </button>
              </div>
              <div className="ds-preview-frame" ref={frameBox}>
                <iframe
                  title={`${preview.name} sample page`}
                  sandbox=""
                  tabIndex={-1}
                  src={stylePreviewUrl(projectId, preview.id, previewTheme)}
                  style={{ transform: `scale(${scale})` }}
                />
              </div>
              <div className="ds-preview-meta">
                <div className="ds-preview-name">{preview.name}</div>
                {preview.description && <div className="ds-preview-desc">{preview.description}</div>}
                <div className="ds-preview-facets">{preview.facets ? facetLabel(preview.facets) : ""}</div>
              </div>
              <div className="ds-preview-actions">
                {preview.facets?.darkPair && (
                  <div className="segmented compact" role="group" aria-label="Preview theme">
                    <button type="button" className={previewTheme === "light" ? "on" : ""} aria-pressed={previewTheme === "light"} onClick={() => setPreviewTheme("light")}>
                      Light
                    </button>
                    <button type="button" className={previewTheme === "dark" ? "on" : ""} aria-pressed={previewTheme === "dark"} onClick={() => setPreviewTheme("dark")}>
                      Dark
                    </button>
                  </div>
                )}
                <button ref={useButton} type="button" className="button primary ds-use" disabled={preview.id === current.id} onClick={() => pick(preview.id)}>
                  {preview.id === current.id ? "In use" : "Use this style"}
                </button>
              </div>
            </div>
          ) : (
            <>
              {hasFacets && (
                <div className="ds-filters" role="group" aria-label="Filter styles">
                  {(["light", "dark"] as const).map((theme) => (
                    <button
                      key={theme}
                      type="button"
                      className="ds-pill"
                      aria-pressed={filter.theme === theme}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => changeFilter({ ...filter, theme: filter.theme === theme ? null : theme })}
                    >
                      {theme === "light" ? "Light" : "Dark"}
                    </button>
                  ))}
                  <span className="ds-filters-sep" />
                  {(["serif", "sans", "mono"] as const).map((display) => (
                    <button
                      key={display}
                      type="button"
                      className="ds-pill"
                      aria-pressed={filter.display === display}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => changeFilter({ ...filter, display: filter.display === display ? null : display })}
                    >
                      {display === "serif" ? "Serif" : display === "sans" ? "Sans" : "Mono"}
                    </button>
                  ))}
                </div>
              )}
              {styleGroups(shown).map((group) => (
                <Fragment key={group.label || "auto"}>
                  {group.label && <div className="model-group">{group.label}</div>}
                  {group.options.map((o) => {
                    const row = (
                      <button
                        data-id={o.id}
                        role="option"
                        aria-selected={o.id === current.id}
                        className={`model-item two-line${o.id === current.id ? " current" : ""}`}
                        onClick={() => pick(o.id)}
                      >
                        <Check size={13} className="check" />
                        <span className="label">
                          {o.name}
                          <span className="desc">{o.description}</span>
                        </span>
                      </button>
                    );
                    if (!o.facets) return <Fragment key={o.id}>{row}</Fragment>;
                    return (
                      <div className="ds-row" key={o.id}>
                        {row}
                        <button
                          type="button"
                          className="icon-button ds-eye"
                          tabIndex={-1}
                          aria-label={`Preview ${o.name}`}
                          title="Preview"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => openPreview(o.id)}
                        >
                          <Eye size={13} />
                        </button>
                      </div>
                    );
                  })}
                </Fragment>
              ))}
              {options.some((o) => o.source === "style") && !shown.some((o) => o.source === "style") && (
                <div className="model-empty">
                  No styles match.{" "}
                  <button type="button" className="ds-clear" onClick={() => changeFilter({ theme: null, display: null })}>
                    Clear filters
                  </button>
                </div>
              )}
              <div className="model-hint">
                Colours follow the style unless your prompt names them
                {hasFacets ? " · → to preview" : ""}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The open design thread's style chip; a pick lands on the next turn. */
export function ThreadDesignStyle({ thread, running }: { thread: Thread; running: boolean }) {
  const setDesignSystem = useStore((s) => s.setDesignSystem);
  return (
    <DesignStyleMenu
      projectId={thread.projectId}
      value={thread.designSystem}
      direction={thread.designDirection ?? null}
      disabled={running}
      onPick={(id) => void setDesignSystem(thread.id, id)}
    />
  );
}

/** The style a design thread about to start will use: Auto until the user picks one. */
export function DraftDesignStyle() {
  const projectId = useStore((s) => s.selectedProjectId);
  const value = useStore((s) => s.draft.designSystem);
  const setDraft = useStore((s) => s.setDraft);
  return <DesignStyleMenu projectId={projectId} value={value} onPick={(id) => setDraft({ designSystem: id })} />;
}
