import { useEffect, useRef, useState } from "react";
import { Lightbulb, MessageSquare, RefreshCw, Trash2, TriangleAlert, X } from "lucide-react";
import type { ExpertDef } from "../../../../shared/experts";
import { ipcError } from "./AddExpertDialog";
import { ExpertAvatar, initials, memberAvatarId } from "./ExpertAvatar";

/** What the detail modal needs: the def, its usage count and the actions. */
export interface ExpertDetailProps {
  def: ExpertDef;
  /** Times this expert has been summoned (localStorage, see ExpertCenter). */
  used: number;
  /** False with no project selected: Summon is disabled with a reason. */
  canSummon: boolean;
  onClose(): void;
  onSummon(): void;
  /** Summon pre-filling the composer with a quick prompt. */
  onSummonPrompt(prompt: string): void;
  /** Remove this imported expert; absent for the built-ins. */
  onRemove?(): Promise<void>;
  /** Re-import an imported expert from its sourceUrl; absent without one. */
  onUpdate?(): Promise<void>;
}

/**
 * An expert's detail: avatar, name and persona, description, tags, stats, its
 * quick prompts, and, for a team, the lead and member roster. Follows
 * AboutSheet's modal pattern: role="dialog", a backdrop that closes on click,
 * Escape, and focus moved into the sheet on open.
 */
export function ExpertDetail(props: ExpertDetailProps) {
  const { onClose } = props;
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    sheet.current?.focus();
  }, []);

  return (
    <div className="sheet-backdrop xc-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={sheet} tabIndex={-1} className="sheet xc-detail" role="dialog" aria-modal="true" aria-label={`${props.def.name} details`}>
        <ExpertDetailContent {...props} />
      </div>
    </div>
  );
}

/** The modal's body, split out so a test can render and drive it without the shell's effects. */
export function ExpertDetailContent({ def, used, canSummon, onClose, onSummon, onSummonPrompt, onRemove, onUpdate }: ExpertDetailProps) {
  const notReady = canSummon ? undefined : "Open a project first";
  const team = def.kind === "team";
  const members = def.members ?? [];
  return (
    <>
      <div className="xc-detail-head">
        <ExpertAvatar id={def.id} text={def.avatarText} className="xc-detail-avatar" />
        <div className="xc-detail-title">
          <h3>
            {def.name}
            {def.persona ? <span className="xc-detail-persona"> | {def.persona}</span> : null}
          </h3>
          {def.profession ? <p className="xc-detail-profession">{def.profession}</p> : null}
        </div>
        <button className="button primary" disabled={!canSummon} title={notReady} onClick={onSummon}>
          Summon
        </button>
        <button className="icon-button" aria-label="Close" title="Close" onClick={onClose}>
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      {def.description ? <p className="xc-detail-desc">{def.description}</p> : null}
      {def.tags.length > 0 && (
        <div className="wb-tags xc-detail-tags">
          {def.tags.map((t) => (
            <span key={t} className="wb-tag">
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="xc-detail-stats">
        v{def.version} · {def.source === "imported" ? "Imported" : "Built in"} · Used {used}×
      </div>

      {def.source === "imported" && (
        <div className="xc-source">
          {def.sourceUrl ? (
            <p className="xc-source-row">
              Source:{" "}
              {def.sourceUrl.startsWith("https://") ? (
                <a href={def.sourceUrl} target="_blank" rel="noreferrer">
                  {def.sourceUrl}
                </a>
              ) : (
                def.sourceUrl
              )}
            </p>
          ) : null}
          {def.author ? <p className="xc-source-row">Author: {def.author}</p> : null}
          {def.license && def.license !== "none" ? <p className="xc-source-row">License: {def.license}</p> : null}
          {!def.license || def.license === "none" ? (
            <p className="xc-license-warn" role="note">
              <TriangleAlert size={14} strokeWidth={1.75} aria-hidden />
              No license: for your own use
            </p>
          ) : null}
          <ExpertSourceActions onUpdate={onUpdate} onRemove={onRemove} />
        </div>
      )}

      {def.quickPrompts.length > 0 && (
        <div className="xc-detail-section">
          <h4>
            <Lightbulb size={14} strokeWidth={1.75} aria-hidden />
            Can help with
          </h4>
          <div className="xc-prompts">
            {def.quickPrompts.map((prompt) => (
              <button key={prompt} className="xc-prompt" disabled={!canSummon} title={notReady} onClick={() => onSummonPrompt(prompt)}>
                <span className="xc-prompt-text">{prompt}</span>
                <MessageSquare size={14} strokeWidth={1.75} aria-hidden />
              </button>
            ))}
          </div>
        </div>
      )}

      {team && (
        <div className="xc-detail-section">
          <h4>Team</h4>
          <div className="xc-team">
            <div className="xc-team-row">
              <ExpertAvatar id={def.id} text={def.avatarText} className="xc-team-avatar" />
              <div className="xc-team-name">
                {def.persona}
                {def.persona && def.profession ? <span className="xc-team-prof"> · {def.profession}</span> : null}
              </div>
            </div>
            {members.map((m) => (
              <div key={m.id} className="xc-team-row">
                <ExpertAvatar id={memberAvatarId(def.id, m.id)} text={initials(m.name)} className="xc-team-avatar" />
                <div className="xc-team-name">
                  {m.name}
                  {m.profession ? <span className="xc-team-prof"> · {m.profession}</span> : null}
                </div>
                {m.description ? <p className="xc-team-desc">{m.description}</p> : null}
              </div>
            ))}
          </div>
          <p className="xc-note">A team runs several agents, so it uses more model calls than one expert.</p>
        </div>
      )}

      {def.skills.length > 0 && (
        <div className="xc-detail-section">
          <h4>Skills</h4>
          <div className="wb-tags">
            {def.skills.map((s) => (
              <span key={s} className="wb-tag">
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      <p className="xc-detail-id">ID: {def.id}</p>
    </>
  );
}

/**
 * Update and two-step Remove for an imported expert. Remove asks once more
 * ("Confirm remove") before it runs; both buttons show a busy label while their
 * promise is in flight, and any failure shows the IPC error's own text.
 */
function ExpertSourceActions({ onUpdate, onRemove }: { onUpdate?(): Promise<void>; onRemove?(): Promise<void> }) {
  const [busy, setBusy] = useState<"update" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const runAction = async (kind: "update" | "remove", action: (() => Promise<void>) | undefined) => {
    if (!action) return;
    setBusy(kind);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(ipcError(err));
    } finally {
      setBusy(null);
    }
  };

  if (!onUpdate && !onRemove) return null;

  return (
    <>
      <div className="xc-source-actions">
        {onUpdate ? (
          <button className="button ghost" disabled={busy !== null} onClick={() => void runAction("update", onUpdate)}>
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
            {busy === "update" ? "Updating…" : "Update"}
          </button>
        ) : null}
        {onRemove ? (
          <button
            className="button ghost danger"
            disabled={busy !== null}
            onClick={() => {
              if (!confirmRemove) {
                setConfirmRemove(true);
                return;
              }
              void runAction("remove", onRemove);
            }}
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden />
            {busy === "remove" ? "Removing…" : confirmRemove ? "Confirm remove" : "Remove"}
          </button>
        ) : null}
      </div>
      {actionError ? (
        <p className="xc-add-error" role="alert">
          {actionError}
        </p>
      ) : null}
    </>
  );
}
