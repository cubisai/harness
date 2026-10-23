import { Check, ChevronDown } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { AUTO_SYSTEM, modeLabel, type DesignDirection } from "../../../shared/direction";
import type { DesignSystemOption, Thread } from "../../../shared/types";
import { api } from "../api";
import { focusOption, focusSelectedOption } from "../option-keys";
import { useStore } from "../store";

/** The system a thread uses when it names none (or one that's gone): the project's own, else Clean, else the first. */
export function shownSystem(options: DesignSystemOption[], id: string | undefined): DesignSystemOption | undefined {
  return (id ? options.find((o) => o.id === id) : undefined) ?? options.find((o) => o.id === "project") ?? options.find((o) => o.id === "clean") ?? options[0];
}

/** The menu's Auto entry: the agent picks a style per brief. */
export const AUTO_OPTION: DesignSystemOption = {
  id: AUTO_SYSTEM,
  name: "Auto",
  description: "Picks a style that fits each brief; your project's own DESIGN.md still wins",
  swatches: [],
  source: "builtin",
};

/** What a system chip shows: its name, swatches and tooltip. */
export interface ChipSystem {
  id: string;
  name: string;
  swatches: string[];
  title: string;
}

/**
 * The chip's view of a value: Auto (with the style and mode its agent chose, once it has) or the fixed system. A draft
 * with nothing picked is Auto, since that's what a new design thread starts on; a stored thread with nothing picked
 * keeps the old default.
 */
export function chipSystem(options: DesignSystemOption[], value: string | undefined, direction?: DesignDirection, unsetIsAuto = false): ChipSystem | undefined {
  if (value === AUTO_SYSTEM || (value === undefined && unsetIsAuto)) {
    const picked = direction ? options.find((o) => o.id === direction.style) : undefined;
    if (!picked || !direction) return { id: AUTO_SYSTEM, name: "Auto", swatches: [], title: "Design system: Auto (picks a style that fits the brief)" };
    return {
      id: AUTO_SYSTEM,
      name: `Auto · ${picked.name}`,
      swatches: picked.swatches,
      title: `Design system: Auto, ${modeLabel(direction.mode)} ${direction.surface} in ${picked.name}`,
    };
  }
  const s = shownSystem(options, value);
  return s && { id: s.id, name: s.name, swatches: s.swatches, title: `Design system: ${s.name}` };
}

/** The style a thread's design is drawn in, by name (the board's `Page · Style` labels): Auto's pick, else the fixed system. */
export function designStyleName(options: DesignSystemOption[], value: string | undefined, direction?: DesignDirection | null): string | undefined {
  if (value === AUTO_SYSTEM) return direction ? options.find((o) => o.id === direction.style)?.name : undefined;
  return shownSystem(options, value)?.name;
}

/** The menu's sections: Auto, then the design systems, then the style library. */
export function systemGroups(options: DesignSystemOption[]): { label: string; options: DesignSystemOption[] }[] {
  const systems = options.filter((o) => o.source !== "style");
  const styles = options.filter((o) => o.source === "style");
  return [
    { label: "", options: [AUTO_OPTION] },
    { label: "Systems", options: systems },
    ...(styles.length ? [{ label: "Styles", options: styles }] : []),
  ];
}

export function Swatches({ colors }: { colors: string[] }) {
  if (!colors.length) return null;
  return (
    <span className="ds-swatches" aria-hidden="true">
      {colors.map((c, i) => (
        <span key={i} className="ds-swatch" style={{ backgroundColor: c }} />
      ))}
    </span>
  );
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

/**
 * A design thread's design-system chip, beside the mode chip: shows the active
 * system and opens a menu of the project's own systems and the built-ins.
 */
export function DesignSystemMenu({
  projectId,
  value,
  direction,
  unsetIsAuto,
  disabled,
  onPick,
}: {
  projectId: string | null;
  value: string | undefined;
  direction?: DesignDirection;
  unsetIsAuto?: boolean;
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
  const current = chipSystem(options, value, direction, unsetIsAuto);
  if (!current) return null;
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
        <Swatches colors={current.swatches.slice(0, 3)} />
        <span className="ds-chip-label">{current.name}</span>
        <ChevronDown size={12} className="chev" />
      </button>
      {open && (
        <div ref={menu} className="model-menu up ds-menu" role="listbox" aria-label="Design system">
          {systemGroups(options).map((group) => (
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
                    <span className="ds-name">
                      {o.name}
                      <Swatches colors={o.swatches} />
                    </span>
                    <span className="desc">{o.description}</span>
                  </span>
                </button>
              ))}
            </Fragment>
          ))}
          <div className="model-hint">Your own: .agents/design-systems</div>
        </div>
      )}
    </div>
  );
}

/** The open design thread's system chip. */
export function ThreadDesignSystem({ thread, running }: { thread: Thread; running: boolean }) {
  const setDesignSystem = useStore((s) => s.setDesignSystem);
  return (
    <DesignSystemMenu
      projectId={thread.projectId}
      value={thread.designSystem}
      {...(thread.designDirection ? { direction: thread.designDirection } : {})}
      disabled={running}
      onPick={(id) => void setDesignSystem(thread.id, id)}
    />
  );
}

/** The system a design thread about to start will use: Auto until the user picks one. */
export function DraftDesignSystem() {
  const projectId = useStore((s) => s.selectedProjectId);
  const value = useStore((s) => s.draft.designSystem);
  const setDraft = useStore((s) => s.setDraft);
  return <DesignSystemMenu projectId={projectId} value={value} unsetIsAuto onPick={(id) => setDraft({ designSystem: id })} />;
}
