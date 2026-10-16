import { useEffect, useMemo } from "react";
import type { ExpertDef } from "../../../../shared/experts";
import type { ThreadEvent } from "../../../../shared/types";
import { useStore } from "../../store";
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

/** The strip's markup, hook-free so a test can render it directly. */
export function TeamStripView({ def, active }: { def: ExpertDef; active: Set<string> }) {
  const members = def.members ?? [];
  if (def.kind !== "team" || members.length === 0) return null;
  const working = members.filter((m) => active.has(m.id)).length;
  return (
    <div className="team-strip" role="group" aria-label={`${def.name} team`}>
      <span className="team-strip-lead">
        <ExpertAvatar id={def.id} text={def.avatarText} className="team-strip-avatar" />
        <span>Lead</span>
      </span>
      {members.map((m) => {
        const on = active.has(m.id);
        return (
          <span
            key={m.id}
            className={`team-strip-member${on ? " active" : ""}`}
            title={`${m.name} · ${m.profession}${on ? " · working" : ""}`}
            {...(on ? { "aria-current": "true" as const } : {})}
          >
            <ExpertAvatar id={memberAvatarId(def.id, m.id)} text={initials(m.name)} className="team-strip-avatar" />
          </span>
        );
      })}
      <span>{working > 0 ? `${working} working` : `${members.length} members`}</span>
    </div>
  );
}

/** The strip for a thread's expert: reads the catalogue and the thread's events. */
export function TeamStrip({ threadId, expertId }: { threadId: string; expertId: string }) {
  const experts = useStore((s) => s.experts);
  const events = useStore((s) => s.events[threadId]);

  // The catalogue loads on the strip's first render (a thread may open before the Library did).
  useEffect(() => {
    if (experts === null) void useStore.getState().loadExperts();
  }, [experts]);

  const def = experts?.find((e) => e.id === expertId) ?? null;
  const active = useMemo(() => {
    const members = def && def.kind === "team" ? def.members ?? [] : [];
    return activeMembers(events?.map((e) => e.event) ?? [], members.map((m) => m.id));
  }, [events, def]);

  if (!def) return null;
  return <TeamStripView def={def} active={active} />;
}
