import type { PermissionRequest } from "../../../shared/types";
import { useStore } from "../store";

export function PermissionCard({ request }: { request: PermissionRequest }) {
  const respond = useStore((s) => s.respond);
  return (
    <div className="permission-card" role="alertdialog" aria-label={`Allow ${request.toolName}?`}>
      <div className="head">Allow {request.toolName}?</div>
      <code>{request.summary}</code>
      <div className="actions">
        <button className="button danger" onClick={() => void respond(request.requestId, "deny")}>
          Deny
        </button>
        {request.canAlwaysAllow && (
          <button className="button" onClick={() => void respond(request.requestId, "allow-always")}>
            Always Allow
          </button>
        )}
        <button className="button primary" autoFocus onClick={() => void respond(request.requestId, "allow-once")}>
          Allow Once
        </button>
      </div>
    </div>
  );
}
