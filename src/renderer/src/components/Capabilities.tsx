import type { AgentCapabilities, PermissionMode } from "../../../shared/types";

const MODES: PermissionMode[] = ["ask", "auto-edit", "full"];
const MODE_LABELS: Record<PermissionMode, string> = { ask: "Ask", "auto-edit": "Auto-edit", full: "Full" };

/** The labels of the modes where the guardrail can't veto a command before it runs. */
function warnOnlyModes(c: AgentCapabilities): string[] {
  return MODES.filter((m) => c.guardEnforcement[m] === "warnOnly").map((m) => MODE_LABELS[m]);
}

/** The capability chips the Library shows for one agent, in a fixed order. */
export function capabilityChips(c: AgentCapabilities): string[] {
  const warn = warnOnlyModes(c);
  const guardrails =
    warn.length === 0
      ? "Guardrails: block"
      : warn.length === MODES.length
        ? "Guardrails: warn-only"
        : `Guardrails: block (warn-only in ${warn.join(", ")})`;
  return [
    guardrails,
    `MCP over HTTP: ${c.mcpHttp ? "yes" : "no"}`,
    skillsChip(c),
    `Fork & rollback: ${c.fork && c.revert ? "yes" : "no"}`,
    `Compaction: ${c.compaction ? "yes" : "no"}`,
  ];
}

/** How model-invoked skills reach it, worded from the delivery mode. */
function skillsChip(c: AgentCapabilities): string {
  const d = c.skillsDelivery;
  if (d.mode === "plugin") return "Skills: plugin";
  if (d.mode === "extraRoots" || d.mode === "envDir") return "Skills: extra folder";
  if (d.mode === "tool") return "Skills: skill tool";
  return "Skills: none";
}

/** Everything this agent can't do here, worded from its capabilities alone. */
export function cantDo(c: AgentCapabilities): string[] {
  const warn = warnOnlyModes(c);
  const out: string[] = [];
  if (warn.length === MODES.length) out.push("Block dangerous git commands (guardrails are warn-only)");
  else if (warn.length > 0) out.push(`Block dangerous git commands in ${warn.join(", ")} (warn-only there)`);
  if (!c.mcpHttp) out.push("Use MCP over HTTP (only stdio servers reach it)");
  if (c.skillsDelivery.mode === "none") out.push("Load model-invoked skills on its own");
  if (!(c.fork && c.revert)) out.push("Fork or roll back a conversation");
  if (!c.compaction) out.push("Compact a long conversation");
  return out;
}

export function CapabilityChips({ capabilities }: { capabilities: AgentCapabilities }) {
  return (
    <div className="wb-tags">
      {capabilityChips(capabilities).map((chip) => (
        <span key={chip} className="wb-tag">
          {chip}
        </span>
      ))}
    </div>
  );
}

export function CantDoList({ capabilities }: { capabilities: AgentCapabilities }) {
  const items = cantDo(capabilities);
  if (!items.length) return null;
  return (
    <div className="wb-cant">
      <div className="wb-cant-title">What this agent can't do here</div>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
