import type { AgentInfo, ModelOption, PermissionMode, Thread } from "../../../shared/types";
import { MODE_ORDER } from "../modes";
import { useStore } from "../store";
import { AgentPicker } from "./AgentPicker";
import { EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";

const MODES: Record<PermissionMode, { label: string; title: string }> = {
  ask: { label: "Ask", title: "Ask before edits and commands" },
  "auto-edit": { label: "Auto-edit", title: "Edit files freely, ask before commands" },
  plan: { label: "Plan", title: "Investigate read-only, then present a plan to approve" },
  full: { label: "Full", title: "Run everything without asking" },
};

/** The thread's agent's models, keeping the current one listed even if the agent no longer reports it. */
function modelOptions(agents: AgentInfo[], agent: string, current: string): ModelOption[] {
  const list = agents.find((a) => a.id === agent)?.models ?? [];
  return list.some((m) => m.id === current) ? list : [{ id: current, label: current }, ...list];
}

/** Agent, model, effort and permission mode buttons: the message box's bar, for a thread or a draft. */
function Controls({
  agents,
  agent,
  model,
  models,
  effort,
  defaultEffort,
  permissionMode,
  disabled,
  onAgent,
  onModel,
  onEffort,
  onPermission,
}: {
  agents: AgentInfo[];
  agent: string;
  model: string;
  models: ModelOption[];
  effort: string | null;
  defaultEffort?: string;
  permissionMode: PermissionMode;
  disabled?: boolean;
  onAgent(id: string): void;
  onModel(id: string): void;
  onEffort(effort: string | null): void;
  onPermission(mode: PermissionMode): void;
}) {
  return (
    <div className="thread-controls">
      {agents.length > 1 && <AgentPicker agents={agents} current={agent} disabled={disabled} onPick={onAgent} />}
      <ModelPicker models={models} current={model} disabled={disabled} placement="up" listenForOpenRequest onPick={onModel} />
      <EffortPicker options={models.find((m) => m.id === model)?.efforts ?? []} current={effort} defaultEffort={defaultEffort} disabled={disabled} onPick={onEffort} />
      <div className="segmented compact" role="radiogroup" aria-label="Permissions">
        {MODE_ORDER.map((id) => {
          const m = MODES[id];
          return (
            <button
              key={id}
              role="radio"
              aria-checked={permissionMode === id}
              className={permissionMode === id ? "on" : ""}
              title={m.title}
              disabled={disabled}
              onClick={() => onPermission(id)}
            >
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Agent, model, reasoning effort and permission mode for the open thread, in the message box's bar. */
export function ThreadControls({ thread, running }: { thread: Thread; running: boolean }) {
  const agents = useStore((s) => s.agents);
  const { updateThread, openSwitch } = useStore.getState();
  const models = modelOptions(agents, thread.agent, thread.model);
  const model = models.find((m) => m.id === thread.model);
  return (
    <Controls
      agents={agents}
      agent={thread.agent}
      model={thread.model}
      models={models}
      effort={thread.effort}
      defaultEffort={model?.defaultEffort}
      permissionMode={thread.permissionMode}
      disabled={running}
      onAgent={openSwitch}
      onModel={(m) => void updateThread({ model: m })}
      onEffort={(effort) => void updateThread({ effort })}
      onPermission={(permissionMode) => void updateThread({ permissionMode })}
    />
  );
}

/** The same controls before a thread exists: picks land in the store's draft, for the thread about to start. */
export function DraftControls() {
  const agents = useStore((s) => s.agents);
  const lastAgent = useStore((s) => s.lastAgent);
  const settings = useStore((s) => s.settings);
  const draft = useStore((s) => s.draft);
  const setDraft = useStore((s) => s.setDraft);
  if (!agents.length) return null;
  const agent = draft.agent ?? lastAgent ?? settings?.defaultAgent ?? agents[0]!.id;
  const model = draft.model ?? agents.find((a) => a.id === agent)?.defaultModel ?? "";
  const models = modelOptions(agents, agent, model);
  return (
    <Controls
      agents={agents}
      agent={agent}
      model={model}
      models={models}
      effort={draft.effort ?? null}
      defaultEffort={models.find((m) => m.id === model)?.defaultEffort}
      permissionMode={draft.permissionMode ?? settings?.defaultPermissionMode ?? "ask"}
      onAgent={(id) => setDraft({ agent: id })}
      onModel={(m) => setDraft({ model: m })}
      onEffort={(effort) => setDraft({ effort })}
      onPermission={(permissionMode) => setDraft({ permissionMode })}
    />
  );
}
