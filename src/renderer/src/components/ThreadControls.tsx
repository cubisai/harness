import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ClipboardList, Hand, Pencil, Zap } from "lucide-react";
import type { AgentInfo, ModelOption, PermissionMode, Thread } from "../../../shared/types";
import { MODE_ORDER } from "../modes";
import { useStore } from "../store";
import { ModelPicker } from "./ModelPicker";

export const MODES: Record<PermissionMode, { label: string; title: string; Icon: typeof Hand }> = {
  ask: { label: "Ask", title: "Ask before edits and commands", Icon: Hand },
  "auto-edit": { label: "Auto-edit", title: "Edit files freely, ask before commands", Icon: Pencil },
  plan: { label: "Plan", title: "Investigate read-only, then present a plan to approve", Icon: ClipboardList },
  full: { label: "Full access", title: "Run everything without asking", Icon: Zap },
};

/** The thread's agent's models, keeping the current one listed even if the agent no longer reports it. */
function modelOptions(agents: AgentInfo[], agent: string, current: string): ModelOption[] {
  const list = agents.find((a) => a.id === agent)?.models ?? [];
  return list.some((m) => m.id === current) ? list : [{ id: current, label: current }, ...list];
}

/**
 * The permission mode as one chip that opens a menu (DESIGN.md §7.3). Shift+Tab
 * still cycles in the message box; Full access reads in the danger colour.
 */
export function ModeMenu({ mode, disabled, onPick }: { mode: PermissionMode; disabled?: boolean; onPick(mode: PermissionMode): void }) {
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
  const m = MODES[mode];
  return (
    <div
      className="model-picker"
      ref={box}
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        className={`chip-button mode-chip${mode === "full" ? " danger" : ""}`}
        title={`${m.title} (Shift+Tab cycles)`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <m.Icon size={13} />
        <span className="mode-chip-label">{m.label}</span>
        <ChevronDown size={12} className="chev" />
      </button>
      {open && (
        <div className="model-menu up mode-menu" role="listbox" aria-label="Permissions">
          <div className="model-group">Permissions</div>
          {MODE_ORDER.map((id) => {
            const o = MODES[id];
            return (
              <button
                key={id}
                role="option"
                aria-selected={id === mode}
                className={`model-item two-line${id === mode ? " current" : ""}${id === "full" ? " danger" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (id !== mode) onPick(id);
                }}
              >
                <Check size={13} className="check" />
                <span className="label">
                  {o.label}
                  <span className="desc">{o.title}</span>
                </span>
              </button>
            );
          })}
          <div className="model-hint">⇧Tab cycles</div>
        </div>
      )}
    </div>
  );
}

/** What the controls show and do, for a thread or for the draft before one exists. */
interface Picks {
  agents: AgentInfo[];
  agent: string;
  model: string;
  models: ModelOption[];
  effort: string | null;
  contextWindow: number | null;
  permissionMode: PermissionMode;
  disabled?: boolean;
  onAgent(id: string): void;
  onModel(id: string): void;
  onEffort(effort: string | null): void;
  onContextWindow(value: number | null): void;
  onPermission(mode: PermissionMode): void;
}

function useThreadPicks(thread: Thread, running: boolean): Picks {
  const agents = useStore((s) => s.agents);
  const { updateThread, openSwitch } = useStore.getState();
  return {
    agents,
    agent: thread.agent,
    model: thread.model,
    models: modelOptions(agents, thread.agent, thread.model),
    effort: thread.effort,
    contextWindow: thread.contextWindow ?? null,
    permissionMode: thread.permissionMode,
    disabled: running,
    onAgent: openSwitch,
    onModel: (m) => void updateThread({ model: m }),
    onEffort: (effort) => void updateThread({ effort }),
    onContextWindow: (contextWindow) => void updateThread({ contextWindow }),
    onPermission: (permissionMode) => void updateThread({ permissionMode }),
  };
}

function useDraftPicks(): Picks | null {
  const agents = useStore((s) => s.agents);
  const lastAgent = useStore((s) => s.lastAgent);
  const settings = useStore((s) => s.settings);
  const draft = useStore((s) => s.draft);
  const setDraft = useStore((s) => s.setDraft);
  if (!agents.length) return null;
  const agent = draft.agent ?? lastAgent ?? settings?.defaultAgent ?? agents[0]!.id;
  const model = draft.model ?? agents.find((a) => a.id === agent)?.defaultModel ?? "";
  return {
    agents,
    agent,
    model,
    models: modelOptions(agents, agent, model),
    effort: draft.effort ?? null,
    contextWindow: draft.contextWindow ?? null,
    permissionMode: draft.permissionMode ?? settings?.defaultPermissionMode ?? "ask",
    onAgent: (id) => setDraft({ agent: id }),
    onModel: (m) => setDraft({ model: m }),
    onEffort: (effort) => setDraft({ effort }),
    onContextWindow: (contextWindow) => setDraft({ contextWindow }),
    onPermission: (permissionMode) => setDraft({ permissionMode }),
  };
}

function Mode({ p }: { p: Picks }) {
  return <ModeMenu mode={p.permissionMode} disabled={p.disabled} onPick={p.onPermission} />;
}

function Model({ p }: { p: Picks }) {
  return (
    <ModelPicker
      agents={p.agents}
      agent={p.agent}
      models={p.models}
      current={p.model}
      effort={p.effort}
      defaultEffort={p.models.find((m) => m.id === p.model)?.defaultEffort}
      contextWindow={p.contextWindow}
      disabled={p.disabled}
      listenForOpenRequest
      onModel={p.onModel}
      onAgent={p.onAgent}
      onEffort={p.onEffort}
      onContextWindow={p.onContextWindow}
    />
  );
}

/** The open thread's permission chip, left in the message box's bar. */
export function ThreadMode({ thread, running }: { thread: Thread; running: boolean }) {
  return <Mode p={useThreadPicks(thread, running)} />;
}

/** The open thread's model control (model, thinking, context, agent switch), right in the bar. */
export function ThreadModel({ thread, running }: { thread: Thread; running: boolean }) {
  return <Model p={useThreadPicks(thread, running)} />;
}

/** The draft's permission chip, before a thread exists. */
export function DraftMode() {
  const p = useDraftPicks();
  return p ? <Mode p={p} /> : null;
}

/** The draft's model control: picks land in the store's draft, for the thread about to start. */
export function DraftModel() {
  const p = useDraftPicks();
  return p ? <Model p={p} /> : null;
}

/** Both draft controls together (tests and simple hosts). */
export function DraftControls() {
  const p = useDraftPicks();
  if (!p) return null;
  return (
    <div className="thread-controls">
      <Mode p={p} />
      <Model p={p} />
    </div>
  );
}
