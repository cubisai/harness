import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { AgentInfo, ModelOption } from "../../../shared/types";
import { filterModels } from "../models";
import { useStore } from "../store";

/** A token count for the context labels, e.g. 872000 -> "872K". */
function formatK(n: number): string {
  return `${Math.round(n / 1000)}K`;
}

/** The two context-window choices, or none when the model accepts no larger window. */
export function contextChoices(model?: ModelOption): { label: string; value: number | null }[] {
  if (!model?.contextWindow || !model?.maxContextWindow || model.maxContextWindow <= model.contextWindow) return [];
  return [
    { label: `Default ${formatK(model.contextWindow)}`, value: null },
    { label: `Max ${formatK(model.maxContextWindow)}`, value: model.maxContextWindow },
  ];
}

/** A model's own name without its provider prefix ("tokenharbor/qwen" -> "qwen"). */
export function shortModelLabel(label: string): string {
  return label.includes("/") ? label.slice(label.indexOf("/") + 1) : label;
}

/** "High" for "high", "XHigh" stays as given past the first letter. */
function titleCase(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/** The slider's dot grid: columns × rows of 6px cells, wider than any track so the fill only ever clips it. */
const DOT_COLS = 48;
const DOT_ROWS = 3;

/**
 * Each dot's own blink (delay, length, peak), from a fixed pseudo-random
 * sequence: the dots flicker out of step like fireflies, and the pattern
 * doesn't reshuffle on every render.
 */
const DOTS: CSSProperties[] = Array.from({ length: DOT_COLS * DOT_ROWS }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return { "--d": `${(-r(1) * 6).toFixed(2)}s`, "--t": `${(3 + r(2) * 4).toFixed(2)}s`, "--peak": (0.55 + r(3) * 0.45).toFixed(2) } as CSSProperties;
});

/** The dot grid, drawn once: moving the slider slides a cover over it instead of re-rendering 192 dots. */
const EffortDots = memo(function EffortDots() {
  return (
    <div className="effort-dots">
      {DOTS.map((style, i) => (
        <i key={i} style={style} />
      ))}
    </div>
  );
});

/**
 * A row of stops as one slider (DESIGN.md §7.3), shared by Thinking and Context.
 * A native range input lies over the drawn track, so drag, arrow keys and
 * screen readers just work; the pick is sent once the drag or key press ends,
 * not at every stop. `index` is the committed stop, `hotFrom` the first stop
 * whose dots glow green.
 */
function StepSlider({
  name,
  ariaLabel,
  labels,
  index,
  label,
  ends,
  hotFrom = Infinity,
  title,
  reset,
  onPick,
}: {
  name: string;
  ariaLabel: string;
  labels: string[];
  index: number;
  /** The head's reading while nothing is being dragged. */
  label: string;
  ends: [string, string];
  hotFrom?: number;
  title?: string;
  reset?: { title: string; onReset(): void };
  onPick(index: number): void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  // A drag follows the pointer closely; a tap or a key press glides.
  const [dragging, setDragging] = useState(false);
  const pressX = useRef<number | null>(null);
  const value = draft ?? index;
  const last = Math.max(1, labels.length - 1);
  const hot = labels.length > 1 && value >= hotFrom;
  const shown = draft === null ? label : (labels[value] ?? "");
  // The knob holds the picked stop until the new value comes back, so it never flicks back to the old one in between.
  useEffect(() => setDraft(null), [index]);
  const commit = () => {
    if (draft === null) return;
    if (draft === index || labels[draft] === undefined) setDraft(null);
    else onPick(draft);
  };
  const release = () => {
    pressX.current = null;
    setDragging(false);
    commit();
  };
  return (
    <div className={`effort${hot ? " hot" : ""}${dragging ? " dragging" : ""}`} style={{ "--p": value / last } as CSSProperties} title={title}>
      <div className="effort-head">
        <span className="model-group">{name}</span>
        <span className="effort-level">{shown}</span>
        {reset && (
          <button className="effort-reset" title={reset.title} onClick={reset.onReset}>
            Reset
          </button>
        )}
      </div>
      <div className="effort-ends" aria-hidden="true">
        <span>{ends[0]}</span>
        <span>{ends[1]}</span>
      </div>
      <div className="effort-control">
        <input
          type="range"
          className="effort-slider"
          min={0}
          max={labels.length - 1}
          step={1}
          value={value}
          aria-label={ariaLabel}
          aria-valuetext={shown}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerDown={(e) => {
            pressX.current = e.clientX;
          }}
          onPointerMove={(e) => {
            if (!dragging && e.buttons && pressX.current !== null && Math.abs(e.clientX - pressX.current) > 3) setDragging(true);
          }}
          onPointerUp={release}
          onKeyUp={commit}
          onBlur={release}
        />
        <div className="effort-track" aria-hidden="true">
          <EffortDots />
          <div className="effort-rail">
            <div className="effort-cover" />
          </div>
          <div className="effort-rail">
            <div className="effort-knob" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Thinking as one Faster ↔ Smarter slider, a stop per level. While unset it rests on the model's own default. */
function ThinkingSlider({ efforts, effort, modelDefault, onEffort }: { efforts: string[]; effort: string | null; modelDefault?: string; onEffort(effort: string | null): void }) {
  const resting = efforts.indexOf(effort ?? modelDefault ?? "");
  const index = resting >= 0 ? resting : Math.floor((efforts.length - 1) / 2);
  // From Xhigh up the dots glow green; without "xhigh", from the level after High (none when High is the top),
  // and a model without "high" heats up over its top third.
  const xhigh = efforts.indexOf("xhigh");
  const high = efforts.indexOf("high");
  const hotFrom = xhigh >= 0 ? xhigh : high >= 0 ? high + 1 : Math.ceil(Math.max(1, efforts.length - 1) * (2 / 3));
  const labels = efforts.map(titleCase);
  const label = effort === null ? (modelDefault ? `${titleCase(modelDefault)} · default` : "Default") : (labels[index] ?? "");
  return (
    <StepSlider
      name="Thinking"
      ariaLabel="Thinking"
      labels={labels}
      index={index}
      label={label}
      ends={["Faster", "Smarter"]}
      hotFrom={hotFrom}
      reset={effort !== null ? { title: modelDefault ? `Back to the model default (${modelDefault})` : "Back to the model default", onReset: () => onEffort(null) } : undefined}
      onPick={(i) => onEffort(efforts[i] ?? null)}
    />
  );
}

/**
 * The composer's one model control (DESIGN.md §7.3): the button reads
 * "Model · Effort"; the menu lists this agent's models (searchable, grouped by
 * provider), the other agents as switch rows, then the Thinking and Context
 * sliders for the current model. Arrow keys move, Return picks, Esc closes.
 */
export function ModelPicker({
  agents,
  agent,
  models,
  current,
  effort,
  defaultEffort,
  contextWindow,
  disabled,
  listenForOpenRequest = false,
  defaultOpen = false,
  onModel,
  onAgent,
  onEffort,
  onContextWindow,
}: {
  agents: AgentInfo[];
  agent: string;
  models: ModelOption[];
  current: string;
  effort: string | null;
  defaultEffort?: string;
  contextWindow?: number | null;
  disabled?: boolean;
  /** Open when the store's requestModelPicker counter changes (only the composer's picker). */
  listenForOpenRequest?: boolean;
  /** Start open (tests render the menu statically). */
  defaultOpen?: boolean;
  onModel(id: string): void;
  onAgent(id: string): void;
  onEffort(effort: string | null): void;
  onContextWindow?(value: number | null): void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => filterModels(models, query), [models, query]);
  const others = useMemo(() => {
    const q = query.toLowerCase();
    return agents.filter((a) => a.id !== agent && (!q || a.label.toLowerCase().includes(q)));
  }, [agents, agent, query]);
  // One flat list for the keyboard: models first, then the switch rows.
  const rows = useMemo(
    () => [...groups.flatMap((g) => g.models.map((m) => ({ kind: "model" as const, id: m.id }))), ...others.map((a) => ({ kind: "agent" as const, id: a.id }))],
    [groups, others],
  );
  const model = models.find((m) => m.id === current);
  const agentLabel = agents.find((a) => a.id === agent)?.label ?? agent;
  const currentLabel = shortModelLabel(model?.label ?? current);
  const efforts = model?.efforts ?? [];
  const modelDefault = defaultEffort ?? model?.defaultEffort;
  const windows = onContextWindow ? contextChoices(model) : [];

  // The composer's "/model" command asks this picker to open, by bumping a counter.
  const openRequest = useStore((s) => s.openPickerRequest);
  const lastRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === lastRequest.current) return;
    lastRequest.current = openRequest;
    if (listenForOpenRequest) setOpen(true);
  }, [openRequest, listenForOpenRequest]);

  useEffect(() => setIndex(Math.max(0, rows.findIndex((r) => r.kind === "model" && r.id === current))), [rows, current]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  // Keep the highlighted row in view while moving with the keyboard.
  useEffect(() => {
    if (open) box.current?.querySelector(".model-item.active")?.scrollIntoView({ block: "nearest" });
  }, [index, open]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const pickRow = (r: { kind: "model" | "agent"; id: string }) => {
    close();
    if (r.kind === "agent") onAgent(r.id);
    else if (r.id !== current) onModel(r.id);
  };

  let row = -1;
  const title = [agentLabel, currentLabel, efforts.length ? `thinking ${effort ?? (modelDefault ? `default (${modelDefault})` : "default")}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="model-picker" ref={box}>
      <button className="chip-button model-picker-button" title={title} disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <span className="model-picker-name">{currentLabel}</span>
        {efforts.length > 0 && (effort ?? modelDefault) && <span className="model-picker-effort">{titleCase((effort ?? modelDefault)!)}</span>}
        <ChevronDown size={12} className="chev" />
      </button>
      {open && (
        <div className="model-menu up right" role="dialog" aria-label="Model">
          <input
            className="model-search"
            autoFocus
            placeholder={`Search ${models.length} ${agentLabel} models`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(rows.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const r = rows[index];
                if (r) pickRow(r);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          />
          <div className="model-list" role="listbox" aria-label={`${agentLabel} models`}>
            {rows.length === 0 && <div className="model-empty">No model matches “{query}”</div>}
            {groups.length > 0 && <div className="model-group">{agentLabel}</div>}
            {groups.map((g) => (
              <div key={g.group || "-"}>
                {g.group && <div className="model-subgroup">{g.group}</div>}
                {g.models.map((m) => {
                  row += 1;
                  const i = row;
                  return (
                    <button
                      key={m.id}
                      role="option"
                      aria-selected={m.id === current}
                      className={`model-item${i === index ? " active" : ""}${m.id === current ? " current" : ""}`}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => pickRow({ kind: "model", id: m.id })}
                    >
                      <Check size={13} className="check" />
                      <span className="label">{m.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {others.length > 0 && <div className="model-group">Switch agent</div>}
            {others.map((a) => {
              row += 1;
              const i = row;
              return (
                <button
                  key={a.id}
                  role="option"
                  aria-selected={false}
                  className={`model-item${i === index ? " active" : ""}`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => pickRow({ kind: "agent", id: a.id })}
                >
                  <span className="check" />
                  <span className="label">{a.label}</span>
                  <span className="hint">switch</span>
                </button>
              );
            })}
          </div>
          <div className="model-options">
              {efforts.length === 0 && (
                <div className="model-option-off" title="This model doesn't take a thinking level">
                  <span className="model-group">Thinking</span>
                  <span>Not offered by {currentLabel}</span>
                </div>
              )}
              {efforts.length > 0 && <ThinkingSlider efforts={efforts} effort={effort} modelDefault={modelDefault} onEffort={onEffort} />}
              {windows.length > 0 && (
                <StepSlider
                  name="Context"
                  ariaLabel="Context window"
                  labels={windows.map((w) => w.label)}
                  index={Math.max(0, windows.findIndex((w) => w.value === (contextWindow ?? null)))}
                  label={windows.find((w) => w.value === (contextWindow ?? null))?.label ?? windows[0]!.label}
                  ends={[formatK(model!.contextWindow!), formatK(model!.maxContextWindow!)]}
                  hotFrom={1}
                  title="A larger window holds more of the conversation before compacting; each turn can cost more."
                  onPick={(i) => onContextWindow?.(windows[i]?.value ?? null)}
                />
              )}
              {efforts.length > 0 && <div className="model-hint">{isMac ? "⌘⌥, ⌘⌥." : "Ctrl+Alt+, Ctrl+Alt+."} thinking</div>}
          </div>
        </div>
      )}
    </div>
  );
}
