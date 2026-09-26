import type { GuardEnforcement, PermissionDecision, PermissionRequest } from "../../../shared/types";
import { useStore } from "../store";

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
  return (
    <div className="permission-card" role="alertdialog" aria-label={`Allow ${request.toolName}?`}>
      <div className="head">Allow {request.toolName}?</div>
      <code>{request.summary}</code>
      {guard === "warnOnly" && (
        <div className="permission-guard warn">
          Git guardrails are warn-only for {agentLabel} in this mode: a dangerous git command won&apos;t be blocked, so check it before allowing.
        </div>
      )}
      {guard === "block" && <div className="permission-guard">Git guardrails on: dangerous git commands are blocked before they run.</div>}
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
