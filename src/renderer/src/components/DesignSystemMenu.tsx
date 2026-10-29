import { Check, ChevronDown, Shapes } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { AUTO_SYSTEM, type DesignDirection } from "../../../shared/direction";
import type { DesignSystemOption, Thread } from "../../../shared/types";
import { api } from "../api";
import { focusOption, focusSelectedOption } from "../option-keys";
import { useStore } from "../store";

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
  const box = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) focusSelectedOption(menu.current);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const current = chipStyle(options, value, direction);
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
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
          chip.current?.focus();
          return;
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
        onClick={() => setOpen((o) => !o)}
      >
        <Shapes size={13} />
        <span className="ds-chip-label">{current.name}</span>
        <ChevronDown size={12} className="chev" />
      </button>
      {open && (
        <div ref={menu} className="model-menu up ds-menu" role="listbox" aria-label="Style">
          {styleGroups(options).map((group) => (
            <Fragment key={group.label || "auto"}>
              {group.label && <div className="model-group">{group.label}</div>}
              {group.options.map((o) => (
                <button
                  key={o.id}
                  role="option"
                  aria-selected={o.id === current.id}
                  className={`model-item two-line${o.id === current.id ? " current" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    chip.current?.focus();
                    if (o.id !== current.id) onPick(o.id);
                  }}
                >
                  <Check size={13} className="check" />
                  <span className="label">
                    {o.name}
                    <span className="desc">{o.description}</span>
                  </span>
                </button>
              ))}
            </Fragment>
          ))}
          <div className="model-hint">Colours follow the style unless your prompt names them</div>
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
