import { useEffect, useRef } from "react";
import { Lightbulb, MessageSquare, X } from "lucide-react";
import type { ExpertDef } from "../../../../shared/experts";
import { ExpertAvatar, initials, memberAvatarId } from "./ExpertAvatar";

/** What the detail modal needs: the def, its usage count and the three actions. */
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
export function ExpertDetailContent({ def, used, canSummon, onClose, onSummon, onSummonPrompt }: ExpertDetailProps) {
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
