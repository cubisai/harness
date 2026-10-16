import { useEffect, useState } from "react";
import type { ExpertDef } from "../../../../shared/experts";
import { api } from "../../api";
import { IconClose } from "../../icons";
import { useStore } from "../../store";
import { ExpertAvatar, initials, memberAvatarId } from "./ExpertAvatar";
import { readUsage } from "./ExpertCenter";
import { ExpertDetail } from "./ExpertDetail";

/**
 * The summoned expert, shown where it works: a chip beside the permission chip
 * in the composer bar (like WorkBuddy), and an intro card at the top of its
 * thread before the first message (see ThreadView). Only the user's explicit
 * Summon sets the expert; the composer's chip has a × that takes it off a thread
 * with no messages yet (after the first turn the expert stays with the thread).
 */

const chipTitle = (def: ExpertDef) => `${def.name} · ${def.profession}`;

/**
 * A chip for an expert already in a thread: its avatar and name, opening its detail. With `threadId` (the composer's
 * chip) it also gets a × while that thread has no messages.
 */
export function ExpertChip({ expertId, threadId }: { expertId: string; threadId?: string }) {
  const experts = useStore((s) => s.experts);
  const canSummon = useStore((s) => Boolean(s.selectedProjectId));
  const empty = useStore((s) => (threadId ? (s.events[threadId]?.length ?? 0) === 0 : false));
  const [open, setOpen] = useState(false);

  // The catalogue loads on the chip's first render (a thread may open before the Library did).
  useEffect(() => {
    if (experts === null) void useStore.getState().loadExperts();
  }, [experts]);

  const def = experts?.find((e) => e.id === expertId);
  if (!def) return null;
  return (
    <ExpertChipView
      def={def}
      used={readUsage()[def.id] ?? 0}
      canSummon={canSummon}
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      onSummon={() => {
        setOpen(false);
        void useStore.getState().summonExpert(def.id);
      }}
      onSummonPrompt={(prompt) => {
        setOpen(false);
        useStore.getState().setComposerDraft(prompt);
      }}
      {...(threadId && empty
        ? {
            onRemove: () => {
              void api()
                .setThreadExpert(threadId, null)
                .then((thread) => useStore.getState().apply({ type: "thread", thread }))
                .catch((err: unknown) => useStore.getState().showNotice(err instanceof Error ? err.message : String(err)));
            },
          }
        : {})}
    />
  );
}

/** The chip and its detail modal, hook-free so a test can drive its click and close. */
export function ExpertChipView({
  def,
  used,
  canSummon,
  open,
  onOpen,
  onClose,
  onSummon,
  onSummonPrompt,
  onRemove,
}: {
  def: ExpertDef;
  used: number;
  canSummon: boolean;
  open: boolean;
  onOpen(): void;
  onClose(): void;
  onSummon(): void;
  onSummonPrompt(prompt: string): void;
  /** Takes the expert off the thread; absent once the thread has messages. */
  onRemove?(): void;
}) {
  return (
    <>
      <button className="chip-button expert-chip" title={chipTitle(def)} aria-label={`Expert: ${def.name}`} onClick={onOpen}>
        <ExpertAvatar id={def.id} text={def.avatarText} className="expert-chip-avatar" />
        <span className="expert-chip-name">
          {def.name}
          {def.kind === "team" && <span className="expert-chip-team">{" · Team"}</span>}
        </span>
      </button>
      {onRemove && (
        <button className="icon-button expert-chip-remove" title="Remove the expert" aria-label={`Remove ${def.name}`} onClick={onRemove}>
          <IconClose />
        </button>
      )}
      {open && <ExpertDetail def={def} used={used} canSummon={canSummon} onClose={onClose} onSummon={onSummon} onSummonPrompt={onSummonPrompt} />}
    </>
  );
}

/** The intro card at the top of an expert thread with no messages yet. */
export function ExpertIntro({ expertId }: { expertId: string }) {
  const experts = useStore((s) => s.experts);

  useEffect(() => {
    if (experts === null) void useStore.getState().loadExperts();
  }, [experts]);

  const def = experts?.find((e) => e.id === expertId);
  if (!def) return null;
  return <ExpertIntroView def={def} />;
}

/** The intro card's markup, hook-free so a test can drive its quick prompts. */
export function ExpertIntroView({ def }: { def: ExpertDef }) {
  const team = def.kind === "team";
  const members = def.members ?? [];
  return (
    <div className="expert-intro">
      <div className="expert-intro-head">
        <ExpertAvatar id={def.id} text={def.avatarText} className="expert-intro-avatar" />
        <div className="expert-intro-title">
          <h3>
            {def.name}
            {def.persona ? <span className="expert-intro-persona"> | {def.persona}</span> : null}
          </h3>
          {def.profession ? <p className="expert-intro-profession">{def.profession}</p> : null}
        </div>
      </div>

      {def.description ? <p className="expert-intro-desc">{def.description}</p> : null}

      {team && (
        <div className="expert-intro-team">
          <div className="expert-intro-members">
            {members.slice(0, 5).map((m) => (
              <ExpertAvatar key={m.id} id={memberAvatarId(def.id, m.id)} text={initials(m.name)} className="expert-intro-member" />
            ))}
          </div>
          <span className="expert-intro-team-line">{members.length} team members</span>
        </div>
      )}
      {team && <p className="expert-intro-team-note">The lead hands parts of the task to members and combines their results.</p>}

      {def.quickPrompts.length > 0 && (
        <div className="expert-intro-prompts">
          <h4>Try asking</h4>
          {def.quickPrompts.map((prompt) => (
            <button key={prompt} className="expert-intro-prompt" onClick={() => useStore.getState().setComposerDraft(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      )}

      <p className="expert-intro-note">Answers come from an AI playing this role, not a human professional. Check important facts.</p>
    </div>
  );
}
