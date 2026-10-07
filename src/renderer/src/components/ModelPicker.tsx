import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { AgentInfo, ModelOption } from "../../../shared/types";
import { providerOfModel } from "../../../shared/provider-rules";
import { filterModels } from "../models";
import { useStore } from "../store";
import { StepSlider } from "./StepSlider";

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
 * provider), the saved providers another agent serves (picking one moves the
 * thread there), the other agents as switch rows, then the Thinking and
 * Context sliders for the current model. Arrow keys move, Return picks, Esc closes.
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
  onAgentModel,
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
  /** Move to another agent on one of its provider models; without it, other agents' providers aren't offered. */
  onAgentModel?(agent: string, model: string): void;
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
  // Saved providers another agent serves that this one doesn't (this agent's own are already in its groups).
  const providers = useMemo(
    () =>
      onAgentModel
        ? agents
            .filter((a) => a.id !== agent)
            .map((a) => ({ agent: a, groups: filterModels(a.models.filter((m) => providerOfModel(m.id) !== null && !models.some((own) => own.id === m.id)), query) }))
            .filter((p) => p.groups.length > 0)
        : [],
    [agents, agent, query, onAgentModel, models],
  );
  // One flat list for the keyboard: models first, then other agents' providers, then the switch rows.
  const rows = useMemo(
    () => [
      ...groups.flatMap((g) => g.models.map((m) => ({ kind: "model" as const, id: m.id }))),
      ...providers.flatMap((p) => p.groups.flatMap((g) => g.models.map((m) => ({ kind: "provider" as const, id: m.id, agent: p.agent.id })))),
      ...others.map((a) => ({ kind: "agent" as const, id: a.id })),
    ],
    [groups, providers, others],
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
  const pickRow = (r: { kind: "model" | "agent" | "provider"; id: string; agent?: string }) => {
    close();
    if (r.kind === "agent") onAgent(r.id);
    else if (r.kind === "provider" && r.agent) onAgentModel?.(r.agent, r.id);
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
            {providers.length > 0 && <div className="model-group">Providers</div>}
            {providers.map((p) =>
              p.groups.map((g) => (
                <div key={`${p.agent.id}:${g.group || "-"}`}>
                  {g.group && <div className="model-subgroup">{g.group}</div>}
                  {g.models.map((m) => {
                    row += 1;
                    const i = row;
                    return (
                      <button
                        key={m.id}
                        role="option"
                        aria-selected={false}
                        className={`model-item${i === index ? " active" : ""}`}
                        onMouseEnter={() => setIndex(i)}
                        onClick={() => pickRow({ kind: "provider", id: m.id, agent: p.agent.id })}
                      >
                        <span className="check" />
                        <span className="label">{m.label}</span>
                        <span className="hint">on {p.agent.label}</span>
                      </button>
                    );
                  })}
                </div>
              )),
            )}
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
