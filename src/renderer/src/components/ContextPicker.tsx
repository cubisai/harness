import { useEffect, useRef, useState } from "react";
import { Ruler } from "lucide-react";
import type { ModelOption } from "../../../shared/types";

/** A token count for the picker's labels, e.g. 872000 -> "872K". */
function formatK(n: number): string {
  return `${Math.round(n / 1000)}K`;
}

/** The two context-window choices, or none when the model accepts no larger window. */
export function contextChoices(model?: ModelOption): { label: string; value: number | null }[] {
  if (!model?.contextWindow || !model?.maxContextWindow || model.maxContextWindow <= model.contextWindow) return [];
  return [
    { label: `Default · ${formatK(model.contextWindow)}`, value: null },
    { label: `Max · ${formatK(model.maxContextWindow)}`, value: model.maxContextWindow },
  ];
}

/**
 * The context-window menu's option buttons. Split out hook-free so tests can
 * call it directly and click its options, like PlanApprovalCardBody.
 */
export function ContextPickerOptions({
  model,
  current,
  onPick,
}: {
  model?: ModelOption;
  current: number | null;
  onPick(value: number | null): void;
}) {
  return (
    <>
      {contextChoices(model).map((choice) => (
        <button
          key={String(choice.value)}
          role="option"
          aria-selected={choice.value === current}
          className={`model-item${choice.value === current ? " current" : ""}`}
          onClick={() => {
            if (choice.value !== current) onPick(choice.value);
          }}
        >
          {choice.label}
        </button>
      ))}
    </>
  );
}

/**
 * The context-window picker: a size button after the effort picker, opening
 * upward. Shown only for a model that accepts a window larger than its default.
 */
export function ContextPicker({
  model,
  current,
  disabled,
  onPick,
}: {
  model?: ModelOption;
  current: number | null;
  disabled?: boolean;
  onPick(value: number | null): void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!contextChoices(model).length) return null;
  const shown = current === model!.maxContextWindow ? formatK(model!.maxContextWindow!) : formatK(model!.contextWindow!);

  return (
    <div className="model-picker" ref={box}>
      <button
        className="select ghost-select model-picker-button"
        title="Context window. A larger window holds more of the conversation before compacting; each turn can cost more."
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Ruler size={14} />
        {shown}
      </button>
      <div className="model-menu up" role="listbox" hidden={!open}>
        <ContextPickerOptions
          model={model}
          current={current}
          onPick={(value) => {
            setOpen(false);
            onPick(value);
          }}
        />
      </div>
    </div>
  );
}
