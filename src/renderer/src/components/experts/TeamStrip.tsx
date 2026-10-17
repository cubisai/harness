import { useEffect, useMemo } from "react";
import type { ExpertDef } from "../../../../shared/experts";
import type { ThreadEvent } from "../../../../shared/types";
import { api } from "../../api";
import { useStore } from "../../store";
import { Beam } from "../Beam";
import { ExpertAvatar, initials, memberAvatarId } from "./ExpertAvatar";

/**
 * The team strip, above the composer where the team works. The lead sits first,
 * then one avatar per member; a member lights up while the agent's handoff to it
 * is in flight. The agent hands work to a member with an `Agent` tool call whose
 * summary ends in ` · <member id>` (the roster in expertBlock).
 */

/**
 * The member ids with a subagent call still in flight. Walks the events in
 * order: an `Agent` tool-use whose summary ends in ` · <id>` for a known member
 * starts one, keyed by its toolUseId; its tool-result ends it; a turn-end or an
 * error ends them all (a run that dies never sends the result).
 */
export function activeMembers(events: ThreadEvent[], memberIds: string[]): Set<string> {
  const known = new Set(memberIds);
  const running = new Map<string, string>(); // toolUseId → member id
  for (const event of events) {
    if (event.kind === "tool-use" && event.name === "Agent") {
      for (const id of known) {
        if (event.summary.endsWith(` · ${id}`)) {
          running.set(event.toolUseId, id);
          break;
        }
      }
    } else if (event.kind === "tool-result") {
      running.delete(event.toolUseId);
    } else if (event.kind === "turn-end" || event.kind === "error") {
      running.clear();
    }
  }
  return new Set(running.values());
}

/**
 * The member ids whose handoff finished in the current turn: an `Agent` call to
 * a known member that got its tool-result after the last user message. With the
 * in-flight ones, it gives the phase's progress ("2 of 3 done").
 */
export function doneMembers(events: ThreadEvent[], memberIds: string[]): Set<string> {
  const known = new Set(memberIds);
  const calls = new Map<string, string>(); // toolUseId → member id
  const done = new Set<string>();
  for (const event of events) {
    if (event.kind === "user") {
      calls.clear();
      done.clear();
    } else if (event.kind === "tool-use" && event.name === "Agent") {
      for (const id of known) {
        if (event.summary.endsWith(` · ${id}`)) {
          calls.set(event.toolUseId, id);
          break;
        }
      }
    } else if (event.kind === "tool-result") {
      const id = calls.get(event.toolUseId);
      if (id) done.add(id);
    }
  }
  return done;
}

/** The strip's status line: who works, then the turn's progress once a member finished. */
export function stripStatus(memberCount: number, working: number, done: number, leadOn: boolean): string {
  const progress = done > 0 ? ` · ${done} of ${done + working} done` : "";
  if (working > 0) return `${working} working${progress}`;
  if (leadOn) return `Lead working${progress}`;
  return `${memberCount} members`;
}

/** How many `--portrait-N` seat tints app.css defines; members past that reuse them in order. */
const PORTRAIT_TINTS = 6;

/**
 * The strip's markup, hook-free so a test can render it directly. While the
 * turn runs and no member is working, the lead is the one working (planning,
 * briefing, writing the answer), so it lights up instead.
 */
export function TeamStripView({
  def,
  active,
  done = new Set(),
  running = false,
  onMember,
}: {
  def: ExpertDef;
  active: Set<string>;
  done?: Set<string>;
  running?: boolean;
  /** Clicking a member: open its newest result file. */
  onMember?: (memberId: string) => void;
}) {
  const members = def.members ?? [];
  if (def.kind !== "team" || members.length === 0) return null;
  const working = members.filter((m) => active.has(m.id)).length;
  const leadOn = running && working === 0;
  // A member that finished and was briefed again counts as working, not done.
  const finished = running ? members.filter((m) => done.has(m.id) && !active.has(m.id)).length : 0;
  return (
    <div className="team-strip" role="group" aria-label={`${def.name} team`}>
      <span className={`team-strip-lead${leadOn ? " active" : ""}`} title={`${def.persona || def.name} · ${def.profession}${leadOn ? " · working" : ""}`} {...(leadOn ? { "aria-current": "true" as const } : {})}>
        <span className="team-strip-face">
          {leadOn && <Beam />}
          <ExpertAvatar id={def.id} text={def.avatarText} className="team-strip-avatar" />
        </span>
        <span>Lead</span>
      </span>
      {members.map((m, i) => {
        const on = active.has(m.id);
        return (
          <button
            type="button"
            key={m.id}
            className={`team-strip-member${on ? " active" : ""}`}
            title={`${m.name} · ${m.profession}${on ? " · working" : running && done.has(m.id) ? " · done" : ""} · open latest result`}
            aria-label={`${m.name}: open latest result`}
            onClick={() => onMember?.(m.id)}
            {...(on ? { "aria-current": "true" as const } : {})}
          >
            <span className="team-strip-face">
              {on && <Beam />}
              <span className="team-strip-tint" data-tint={(i % PORTRAIT_TINTS) + 1}>
                <ExpertAvatar id={memberAvatarId(def.id, m.id)} text={initials(m.name)} className="team-strip-avatar" />
              </span>
            </span>
          </button>
        );
      })}
      <span aria-live="polite">{stripStatus(members.length, working, finished, leadOn)}</span>
    </div>
  );
}

/** The strip for a thread's expert: reads the catalogue and the thread's events. */
export function TeamStrip({ threadId, expertId }: { threadId: string; expertId: string }) {
  const experts = useStore((s) => s.experts);
  const events = useStore((s) => s.events[threadId]);
  const running = useStore((s) => s.running[threadId] === true);

  // The catalogue loads on the strip's first render (a thread may open before the Library did).
  useEffect(() => {
    if (experts === null) void useStore.getState().loadExperts();
  }, [experts]);

  const def = experts?.find((e) => e.id === expertId) ?? null;
  const { active, done } = useMemo(() => {
    const ids = (def && def.kind === "team" ? def.members ?? [] : []).map((m) => m.id);
    const list = events?.map((e) => e.event) ?? [];
    return { active: activeMembers(list, ids), done: doneMembers(list, ids) };
  }, [events, def]);

  // A member with no result yet opens nothing.
  const openResult = (memberId: string) => {
    void api()
      .teamMemberFile(threadId, memberId)
      .then((path) => {
        if (path) useStore.getState().openArtifact(path, threadId);
      })
      .catch(() => {});
  };

  if (!def) return null;
  return <TeamStripView def={def} active={active} done={done} running={running} onMember={openResult} />;
}
