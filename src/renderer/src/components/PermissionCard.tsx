import type { GuardEnforcement, PermissionDecision, PermissionRequest } from "../../../shared/types";
import { useStore } from "../store";

/** Card titles that mean a shell command: Claude and the native harness say Bash, ACP and Codex say Run. */
const COMMAND_TOOLS = new Set(["Bash", "Run"]);

export function PermissionCardView({
  request,
  guard,
  agentLabel,
  onRespond,
}: {
  request: PermissionRequest;
  guard: GuardEnforcement | undefined;
  agentLabel: string;
  onRespond: (d: PermissionDecision) => void;
}) {
  // The git guardrail only concerns shell commands, so edit and tool cards skip its note.
  const isCommand = COMMAND_TOOLS.has(request.toolName);
  return (
    <div className="permission-card permission-ask" role="alertdialog" aria-label={`Allow ${request.toolName}?`}>
      <div className="permission-row">
        <span className="permission-tool">{request.toolName}</span>
        <code>{request.summary}</code>
        <div className="actions">
          <button className="button danger" onClick={() => onRespond("deny")}>
            Deny
          </button>
          {request.canAlwaysAllow && (
            <button className="button" onClick={() => onRespond("allow-always")}>
              Always Allow
            </button>
          )}
          <button className="button primary" autoFocus onClick={() => onRespond("allow-once")}>
            Allow Once
          </button>
        </div>
      </div>
      {isCommand && guard === "warnOnly" && (
        <div className="permission-guard warn">Git guardrails are warn-only for {agentLabel} here: check git commands before allowing.</div>
      )}
      {isCommand && guard === "block" && <div className="permission-guard">Git guardrails on: dangerous git commands are blocked before they run.</div>}
    </div>
  );
}

export function PermissionCard({ request }: { request: PermissionRequest }) {
  const respond = useStore((s) => s.respond);
  const thread = useStore((s) => Object.values(s.threads).flat().find((t) => t.id === request.threadId));
  const info = useStore((s) => s.agents.find((a) => a.id === thread?.agent));
  const guard = thread ? info?.capabilities.guardEnforcement[thread.permissionMode] : undefined;
  const agentLabel = info?.label ?? "this agent";
  return <PermissionCardView request={request} guard={guard} agentLabel={agentLabel} onRespond={(d) => void respond(request.requestId, d)} />;
}
