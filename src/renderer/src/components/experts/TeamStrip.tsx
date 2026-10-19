import { useEffect, useMemo } from "react";
import { memberModelLabel, memberModelNote, type ExpertDef, type ExpertMember } from "../../../../shared/experts";
import type { ThreadEvent } from "../../../../shared/types";
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
 * The strip's markup, hook-free so a test can render it directly. While the
 * turn runs and no member is working, the lead is the one working (planning,
 * briefing, writing the answer), so it lights up instead. A member that names
 * its own model or effort shows what it actually runs on in its tooltip.
 */
export function TeamStripView({ def, active, running = false, agent, leadModel }: { def: ExpertDef; active: Set<string>; running?: boolean; agent?: string; leadModel?: string }) {
  const members = def.members ?? [];
  if (def.kind !== "team" || members.length === 0) return null;
  const working = members.filter((m) => active.has(m.id)).length;
  const leadOn = running && working === 0;
  return (
    <div className="team-strip" role="group" aria-label={`${def.name} team`}>
      <span className={`team-strip-lead${leadOn ? " active" : ""}`} title={`${def.persona || def.name} · ${def.profession}${leadOn ? " · working" : ""}`} {...(leadOn ? { "aria-current": "true" as const } : {})}>
        <span className="team-strip-face">
          {leadOn && <Beam />}
          <ExpertAvatar id={def.id} text={def.avatarText} className="team-strip-avatar" />
        </span>
        <span>Lead</span>
      </span>
      {members.map((m) => {
        const on = active.has(m.id);
        return (
          <span
            key={m.id}
            className={`team-strip-member${on ? " active" : ""}`}
            title={`${m.name} · ${m.profession}${runsOn(m, agent, leadModel)}${on ? " · working" : ""}`}
            {...(on ? { "aria-current": "true" as const } : {})}
          >
            <span className="team-strip-face">
              {on && <Beam />}
              <ExpertAvatar id={memberAvatarId(def.id, m.id)} text={initials(m.name)} className="team-strip-avatar" />
            </span>
          </span>
        );
      })}
      <span aria-live="polite">{working > 0 ? `${working} working` : leadOn ? "Lead working" : `${members.length} members`}</span>
    </div>
  );
}

/** " · <model> <effort> (note)" for a member that sets a model or effort, else "". */
function runsOn(m: ExpertMember, agent: string | undefined, leadModel: string | undefined): string {
  if ((!m.model && !m.effort) || agent === undefined) return "";
  const note = memberModelNote(m, agent);
  const label = [memberModelLabel(m, agent, leadModel ?? ""), m.effort].filter(Boolean).join(" ");
  return `${label ? ` · ${label}` : ""}${note ? ` (${note})` : ""}`;
}

/** The strip for a thread's expert: reads the catalogue and the thread's events. */
export function TeamStrip({ threadId, expertId, agent, leadModel }: { threadId: string; expertId: string; agent: string; leadModel: string }) {
  const experts = useStore((s) => s.experts);
  const events = useStore((s) => s.events[threadId]);
  const running = useStore((s) => s.running[threadId] === true);

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
  return <TeamStripView def={def} active={active} running={running} agent={agent} leadModel={leadModel} />;
}
