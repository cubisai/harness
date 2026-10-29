import { useState } from "react";
import { PLAN_ARTIFACT } from "../../../shared/artifact-kind";
import type { PlanDecision, PlanRequest } from "../../../shared/types";
import { Markdown } from "../markdown";
import { useStore } from "../store";

/**
 * The plan-approval card: the agent presented a plan in "plan" mode and waits
 * for the user. It never resolves on its own; "Keep planning" opens a feedback
 * box that goes back as planning guidance.
 */
export function PlanApprovalCardView({ request, onRespond, onOpen, onDesign }: { request: PlanRequest; onRespond: (d: PlanDecision) => void; onOpen?: () => void; onDesign?: () => void }) {
  const [keeping, setKeeping] = useState(false);
  const [feedback, setFeedback] = useState("");
  return (
    <PlanApprovalCardBody
      request={request}
      keeping={keeping}
      feedback={feedback}
      onKeep={() => setKeeping(true)}
      onCancel={() => setKeeping(false)}
      onFeedback={setFeedback}
      onRespond={onRespond}
      onOpen={onOpen}
      onDesign={onDesign}
    />
  );
}

/** The card's markup, hook-free so tests can exercise its buttons directly. */
export function PlanApprovalCardBody({
  request,
  keeping,
  feedback,
  onKeep,
  onCancel,
  onFeedback,
  onRespond,
  onOpen,
  onDesign,
}: {
  request: PlanRequest;
  keeping: boolean;
  feedback: string;
  onKeep(): void;
  onCancel(): void;
  onFeedback(text: string): void;
  onRespond(d: PlanDecision): void;
  /** Opens the plan in the File panel, where every round is a version. */
  onOpen?(): void;
  /** Starts a design of the plan without answering the request; the plan stays pending. */
  onDesign?(): void;
}) {
  return (
    <div className="permission-card plan-card" role="alertdialog" aria-label="Approve the plan?">
      <div className="head plan-card-head">
        <span>Ready to build?</span>
        {onOpen ? (
          <button className="button ghost" onClick={onOpen}>
            Open in panel
          </button>
        ) : null}
      </div>
      <div className="plan-body">
        <Markdown text={request.plan} />
      </div>
      {keeping ? (
        <>
          <textarea
            className="text-input plan-feedback"
            placeholder="What should change about the plan?"
            value={feedback}
            autoFocus
            onChange={(e) => onFeedback(e.target.value)}
          />
          <div className="actions">
            <button className="button" onClick={onCancel}>
              Cancel
            </button>
            <button className="button primary" onClick={() => onRespond({ keep: feedback })}>
              Send feedback
            </button>
          </div>
        </>
      ) : (
        <div className="actions">
          <button className="button" onClick={onKeep}>
            Keep planning
          </button>
          {onDesign ? (
            <button className="button" onClick={onDesign}>
              Design it
            </button>
          ) : null}
          <button className="button" onClick={() => onRespond("manual")}>
            Yes, manually approve edits
          </button>
          <button className="button primary" autoFocus onClick={() => onRespond("auto")}>
            Yes, auto-accept edits
          </button>
        </div>
      )}
    </div>
  );
}

export function PlanApprovalCard({ request }: { request: PlanRequest }) {
  const respondPlan = useStore((s) => s.respondPlan);
  const openArtifact = useStore((s) => s.openArtifact);
  return (
    <PlanApprovalCardView
      request={request}
      onRespond={(d) => void respondPlan(request.requestId, d)}
      onOpen={() => openArtifact(PLAN_ARTIFACT, request.threadId)}
      onDesign={async () => {
        // Design reads the plan as an approved product spec; it never answers the
        // request, so the plan stays pending and can still be approved later.
        const s = useStore.getState();
        await s.setThreadKind("design");
        await s.startThread(`Design the UI for this plan. It is approved as the product spec; the build happens later in the chat thread, so design the screens only.\n\n${request.plan}`);
      }}
    />
  );
}
