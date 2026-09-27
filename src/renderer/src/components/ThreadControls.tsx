import type { AgentInfo, ModelOption, PermissionMode, Thread } from "../../../shared/types";
import { useStore } from "../store";
import { AgentPicker } from "./AgentPicker";
import { EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";

const MODES: { id: PermissionMode; label: string; title: string }[] = [
  { id: "ask", label: "Ask", title: "Ask before edits and commands" },
  { id: "auto-edit", label: "Auto-edit", title: "Edit files freely, ask before commands" },
  { id: "full", label: "Full", title: "Run everything without asking" },
];

/** The thread's agent's models, keeping the current one listed even if the agent no longer reports it. */
function modelOptions(agents: AgentInfo[], agent: string, current: string): ModelOption[] {
  const list = agents.find((a) => a.id === agent)?.models ?? [];
  return list.some((m) => m.id === current) ? list : [{ id: current, label: current }, ...list];
}

/** Agent, model, reasoning effort and permission mode for the open thread, in the message box's bar. */
export function ThreadControls({ thread, running }: { thread: Thread; running: boolean }) {
  const agents = useStore((s) => s.agents);
  const { updateThread, openSwitch } = useStore.getState();
  const models = modelOptions(agents, thread.agent, thread.model);
  const model = models.find((m) => m.id === thread.model);
  return (
    <div className="thread-controls">
      {agents.length > 1 && (
        <AgentPicker agents={agents} current={thread.agent} disabled={running} onPick={openSwitch} />
      )}
      <ModelPicker models={models} current={thread.model} disabled={running} placement="up" onPick={(m) => void updateThread({ model: m })} />
      <EffortPicker
        options={model?.efforts ?? []}
        current={thread.effort}
        defaultEffort={model?.defaultEffort}
        disabled={running}
        onPick={(effort) => void updateThread({ effort })}
      />
      <div className="segmented compact" role="radiogroup" aria-label="Permissions">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="radio"
            aria-checked={thread.permissionMode === m.id}
            className={thread.permissionMode === m.id ? "on" : ""}
            title={m.title}
            disabled={running}
            onClick={() => void updateThread({ permissionMode: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
