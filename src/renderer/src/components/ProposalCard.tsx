import { type Ref, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, Plug, Puzzle } from "lucide-react";
import type { ExtensionProposalView } from "../../../shared/types";
import { api } from "../api";
import { Markdown } from "../markdown";
import { useStore } from "../store";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** SKILL.md for the preview: its YAML frontmatter as a code block, so it doesn't run together as one paragraph. */
export function previewMarkdown(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return md;
  return "```yaml\n" + m[1] + "\n```\n\n" + md.slice(m[0].length);
}

/** Inline transcript card for reviewing and installing/rejecting a Creator mode proposal. */
export function ProposalCard({ proposalId, threadId }: { proposalId: string; threadId: string }) {
  const [proposal, setProposal] = useState<ExtensionProposalView | null | undefined>(undefined);
  const [busy, setBusy] = useState<"install" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Where Install puts it: the user's pick, starting from the scope the agent proposed.
  const [pick, setPick] = useState<"project" | "global" | null>(null);
  const inFlightRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const refocusRef = useRef(false);

  const noticeCount = useStore((s) => (s.events[threadId] ?? []).filter((e) => e.event.kind === "notice").length);
  const seenNoticesRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const view = await api().getExtensionProposal(proposalId);
      setProposal(view);
    } catch {
      setProposal(null);
    }
  }, [proposalId]);

  useEffect(() => {
    let cancelled = false;
    setProposal(undefined);
    setActionError(null);
    setPick(null);
    seenNoticesRef.current = null;
    void api()
      .getExtensionProposal(proposalId)
      .then((view) => {
        if (!cancelled) setProposal(view);
      })
      .catch(() => {
        if (!cancelled) setProposal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

  useEffect(() => {
    if (seenNoticesRef.current === null) {
      seenNoticesRef.current = noticeCount;
      return;
    }
    if (noticeCount !== seenNoticesRef.current) {
      seenNoticesRef.current = noticeCount;
      void load();
    }
  }, [noticeCount, load]);

  // The clicked button unmounts when the status changes: keep keyboard focus in the card.
  useEffect(() => {
    if (!refocusRef.current || busy !== null) return;
    refocusRef.current = false;
    const card = cardRef.current;
    if (!card || (document.activeElement && document.activeElement !== document.body && card.contains(document.activeElement))) return;
    const next = card.querySelector<HTMLElement>(".proposal-foot button:not(:disabled)");
    (next ?? card).focus();
  }, [proposal, busy]);

  if (proposal === undefined) {
    return (
      <div className="proposal-card proposal-card-loading" aria-busy="true">
        Loading proposal…
      </div>
    );
  }
  if (!proposal) return null;

  const handleInstall = async () => {
    if (inFlightRef.current || busy !== null) return;
    inFlightRef.current = true;
    refocusRef.current = cardRef.current?.contains(document.activeElement) ?? false;
    setBusy("install");
    setActionError(null);
    try {
      const updated = await api().installExtension(proposal.id, pick ?? proposal.scope.kind);
      setProposal(updated);
      if (updated.status === "installed" && updated.draft.kind === "skill") {
        void api()
          .listSkills()
          .then((skills) => useStore.setState({ skills }))
          .catch(() => {});
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      void load();
    } finally {
      inFlightRef.current = false;
      setBusy(null);
    }
  };

  const handleReject = async () => {
    if (inFlightRef.current || busy !== null) return;
    inFlightRef.current = true;
    refocusRef.current = cardRef.current?.contains(document.activeElement) ?? false;
    setBusy("reject");
    setActionError(null);
    try {
      const updated = await api().rejectExtension(proposal.id);
      setProposal(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      void load();
    } finally {
      inFlightRef.current = false;
      setBusy(null);
    }
  };

  return (
    <ProposalCardView
      ref={cardRef}
      proposal={proposal}
      busy={busy}
      actionError={actionError}
      previewOpen={previewOpen}
      onTogglePreview={() => setPreviewOpen((v) => !v)}
      onInstall={handleInstall}
      onReject={handleReject}
      scopePick={pick ?? proposal.scope.kind}
      onScopePick={setPick}
    />
  );
}

export interface ProposalCardViewProps {
  proposal: ExtensionProposalView;
  busy: "install" | "reject" | null;
  actionError: string | null;
  previewOpen: boolean;
  onTogglePreview(): void;
  onInstall(): void;
  onReject(): void;
  /** The scope Install uses, shown as a picker while the proposal waits and the thread has a project. */
  scopePick?: "project" | "global";
  onScopePick?(scope: "project" | "global"): void;
  ref?: Ref<HTMLDivElement>;
}

/** The card itself, stateless: every status renders from props (tests render it directly). */
export function ProposalCardView({ proposal, busy, actionError, previewOpen, onTogglePreview, onInstall, onReject, scopePick, onScopePick, ref }: ProposalCardViewProps) {
  const { draft, scope, status } = proposal;
  const scopeLabel = scope.kind === "project" ? `Project${proposal.projectName ? `: ${proposal.projectName}` : ""}` : "Global";
  const waiting = status === "staged" || (status === "failed" && proposal.retryable !== false);
  // The picker replaces the head's scope chip while the user can still choose; Chats threads have only Global.
  const choice = waiting && onScopePick ? proposal.projectChoice : null;
  const picked = scopePick ?? scope.kind;
  const KindIcon = draft.kind === "skill" ? Puzzle : Plug;
  const kindLabel = draft.kind === "skill" ? "Skill" : "Connector";
  const libraryTarget = draft.kind === "skill" ? "skills" : "connectors";
  const errorText = actionError ?? (status === "failed" ? (proposal.error ?? "Installation failed.") : null);

  return (
    <div ref={ref} tabIndex={-1} className={`proposal-card status-${status}`} data-proposal-id={proposal.id}>
      <div className="proposal-head">
        <span className="proposal-icon" aria-hidden>
          <KindIcon size={15} strokeWidth={1.75} />
        </span>
        <span className="proposal-name">{draft.name}</span>
        <span className="proposal-chip">{kindLabel}</span>
        {!choice && <span className="proposal-chip">{scopeLabel}</span>}
        {status !== "staged" && (
          <span className={`proposal-status ${status}`}>
            {status === "installed" ? "Installed" : status === "rejected" ? "Rejected" : "Failed"}
          </span>
        )}
      </div>

      <div className="proposal-body">
        {draft.kind === "skill" ? (
          <>
            <p className="proposal-desc">{draft.description}</p>
            <ul className="proposal-files">
              {draft.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  <span className="proposal-size">{formatBytes(f.bytes)}</span>
                </li>
              ))}
            </ul>
            {draft.skillMd && (
              <div className="proposal-preview-wrap">
                <button
                  type="button"
                  className="proposal-preview-toggle"
                  aria-expanded={previewOpen}
                  onClick={onTogglePreview}
                >
                  <ChevronRight className={`proposal-chevron${previewOpen ? " open" : ""}`} size={14} strokeWidth={1.75} aria-hidden />
                  <span>{previewOpen ? "Hide SKILL.md" : "Preview SKILL.md"}</span>
                </button>
                {previewOpen && (
                  <div className="proposal-preview msg-assistant">
                    <Markdown text={previewMarkdown(draft.skillMd)} />
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="proposal-target">
              <span className="proposal-transport">{draft.type.toUpperCase()}</span>
              <code className="proposal-command">{draft.target}</code>
            </div>
            {draft.type === "stdio" && (
              <div className="proposal-warning">
                <AlertTriangle size={13} strokeWidth={1.75} aria-hidden />
                <span>Runs a local program on this computer.</span>
              </div>
            )}
            {draft.requiredVars.length > 0 && (
              <div className="proposal-vars">
                <span className="proposal-vars-label">Required variables:</span>
                <div className="proposal-vars-list">
                  {draft.requiredVars.map((v) => (
                    <code key={v}>{`\${${v}}`}</code>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {errorText && (
          <div className="proposal-error" role="alert">
            {errorText}
          </div>
        )}
      </div>

      <div className="proposal-foot">
        {choice && (
          <div className="proposal-scope">
            <span className="proposal-scope-label">Install to</span>
            <div className="segmented compact" role="group" aria-label="Install to">
              <button type="button" className={picked === "project" ? "on" : ""} aria-pressed={picked === "project"} disabled={busy !== null} title={choice.name} onClick={() => onScopePick?.("project")}>
                {`Project: ${choice.name}`}
              </button>
              <button type="button" className={picked === "global" ? "on" : ""} aria-pressed={picked === "global"} disabled={busy !== null} title="Every project" onClick={() => onScopePick?.("global")}>
                Global
              </button>
            </div>
          </div>
        )}
        {status === "staged" && (
          <>
            <button type="button" className="button ghost" disabled={busy !== null} onClick={onReject}>
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            <button type="button" className="button primary" disabled={busy !== null} onClick={onInstall}>
              {busy === "install" ? "Installing…" : "Install"}
            </button>
          </>
        )}
        {status === "installed" && (
          <>
            <button type="button" className="button" onClick={() => useStore.setState({ libraryTab: libraryTarget })}>
              Open in Library
            </button>
          </>
        )}
        {status === "failed" && (
          <>
            <button type="button" className="button ghost" disabled={busy !== null} onClick={onReject}>
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            {proposal.retryable !== false && (
              <button type="button" className="button primary" disabled={busy !== null} onClick={onInstall}>
                {busy === "install" ? "Retrying…" : "Retry"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
