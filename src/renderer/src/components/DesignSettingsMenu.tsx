import { Check, ChevronDown } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { TIERS, tierOf } from "../../../shared/tiers";
import type { Thread } from "../../../shared/types";
import { MODE_ORDER } from "../modes";
import { focusOption, focusSelectedOption } from "../option-keys";
import { useStore } from "../store";
import { chipSystem, Swatches, systemGroups, useDesignSystemOptions } from "./DesignSystemMenu";
import { MODES } from "./ThreadControls";

/**
 * A design thread's mode, design system and tier as one chip, for a message box too narrow for three (the Composer
 * swaps it in only then). The chip shows the mode's icon, so Full access still reads in the danger colour; its menu
 * has the three lists the separate chips open.
 */
export function ThreadDesignSettings({ thread, running }: { thread: Thread; running: boolean }) {
  const { updateThread, setDesignSystem, setPrototypeTier } = useStore.getState();
  const [open, setOpen] = useState(false);
  const systems = useDesignSystemOptions(thread.projectId, open, thread.designSystem);
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

  const mode = MODES[thread.permissionMode];
  const system = chipSystem(systems, thread.designSystem, thread.designDirection);
  const tier = tierOf(thread);
  const tierLabel = (TIERS.find((t) => t.value === tier) ?? TIERS[1]!).label;
  const summary = [mode.label, system?.name, tierLabel].filter(Boolean).join(" · ");
  const pick = (fn: () => void) => {
    setOpen(false);
    chip.current?.focus();
    fn();
  };

  return (
    <div
      className="model-picker"
      ref={box}
      onKeyDown={(e) => {
        if (!open) {
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
        className={`chip-button mode-chip design-settings-chip${thread.permissionMode === "full" ? " danger" : ""}`}
        title={`${summary} (Shift+Tab cycles the mode)`}
        aria-label={`Mode, design system and tier: ${summary}`}
        disabled={running}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <mode.Icon size={13} />
        <ChevronDown size={12} className="chev" />
      </button>
      {open && (
        <div ref={menu} className="model-menu up ds-menu design-settings-menu" role="listbox" aria-label="Mode, design system and tier">
          <div className="model-group">Permissions</div>
          {MODE_ORDER.map((id) => (
            <button
              key={id}
              role="option"
              aria-selected={id === thread.permissionMode}
              title={MODES[id].title}
              className={`model-item${id === thread.permissionMode ? " current" : ""}${id === "full" ? " danger" : ""}`}
              onClick={() => pick(() => id !== thread.permissionMode && void updateThread({ permissionMode: id }))}
            >
              <Check size={13} className="check" />
              <span className="label">{MODES[id].label}</span>
            </button>
          ))}
          {systemGroups(systems).map((group) => (
            <Fragment key={group.label || "auto"}>
              <div className="model-group">{group.label || "Design system"}</div>
              {group.options.map((o) => (
                <button
                  key={o.id}
                  role="option"
                  aria-selected={o.id === system?.id}
                  title={o.description || undefined}
                  className={`model-item${o.id === system?.id ? " current" : ""}`}
                  onClick={() => pick(() => o.id !== system?.id && void setDesignSystem(thread.id, o.id))}
                >
                  <Check size={13} className="check" />
                  <span className="label ds-name">
                    {o.name}
                    <Swatches colors={o.swatches} />
                  </span>
                </button>
              ))}
            </Fragment>
          ))}
          <div className="model-group">Prototype tier</div>
          {TIERS.map((t) => (
            <button
              key={t.value}
              role="option"
              aria-selected={t.value === tier}
              title={t.detail}
              className={`model-item${t.value === tier ? " current" : ""}`}
              onClick={() => pick(() => t.value !== tier && void setPrototypeTier(thread.id, t.value))}
            >
              <Check size={13} className="check" />
              <span className="label">{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
