import { useMemo } from "react";
import { useStore } from "../store";
import { PermissionCard } from "./PermissionCard";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { QuestionCardView } from "./QuestionCard";

/**
 * Everything the agent is waiting on the user for, docked above the message
 * box: one card at a time (approvals first, then questions, then the plan),
 * with a count of the rest.
 */
export function RequestDock({ threadId }: { threadId: string }) {
  const allPermissions = useStore((s) => s.permissions);
  const allQuestions = useStore((s) => s.questions);
  const allPlans = useStore((s) => s.plans);
  const respondQuestion = useStore((s) => s.respondQuestion);
  const pending = useMemo(
    () => [
      ...allPermissions.filter((p) => p.threadId === threadId).map((request) => ({ kind: "permission" as const, request })),
      ...allQuestions.filter((q) => q.threadId === threadId).map((request) => ({ kind: "question" as const, request })),
      ...allPlans.filter((p) => p.threadId === threadId).map((request) => ({ kind: "plan" as const, request })),
    ],
    [allPermissions, allQuestions, allPlans, threadId],
  );
  const first = pending[0];
  if (!first) return null;
  const waiting = pending.length - 1;
  return (
    <div className="request-dock">
      {first.kind === "permission" ? (
        <PermissionCard key={first.request.requestId} request={first.request} />
      ) : first.kind === "question" ? (
        <QuestionCardView key={first.request.requestId} request={first.request} waiting={waiting} onRespond={(a) => void respondQuestion(first.request.requestId, a)} />
      ) : (
        <PlanApprovalCard key={first.request.requestId} request={first.request} />
      )}
      {first.kind !== "question" && waiting > 0 && <div className="dock-more">+{waiting} more waiting</div>}
    </div>
  );
}
