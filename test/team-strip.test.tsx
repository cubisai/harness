/// <reference types="vite/client" />
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExpertDef } from "../src/shared/experts";
import type { ThreadEvent } from "../src/shared/types";

/** A def with the boring fields defaulted, so each test states only what it checks. */
const def = (partial: Partial<ExpertDef> & Pick<ExpertDef, "id" | "name">): ExpertDef => ({
  kind: "agent",
  profession: "",
  persona: "",
  category: "General",
  avatarText: partial.name.slice(0, 2).toUpperCase(),
  description: "",
  tags: [],
  quickPrompts: [],
  prompt: "You are helpful.",
  skills: [],
  source: "builtin",
  version: "1.0.0",
  ...partial,
});

const agent = def({ id: "solo-agent", name: "Solo Agent" });
const team = def({
  id: "software-delivery-team",
  name: "Software Delivery Team",
  kind: "team",
  profession: "Engineering Lead",
  persona: "Dana",
  members: [
    { id: "analyst", name: "Data Analyst", profession: "Senior Data Analyst", description: "Analyses data.", prompt: "", skills: [] },
    { id: "writer", name: "Report Writer", profession: "Technical Writer", description: "Writes it up.", prompt: "", skills: [] },
  ],
});
const catalog: ExpertDef[] = [agent, team];

/** An `Agent` tool-use handoff to a member: summary is `<description> · <member id>`. */
const toolUse = (toolUseId: string, id: string): ThreadEvent => ({ kind: "tool-use", toolUseId, name: "Agent", summary: `Hand the step over · ${id}` });
const toolResult = (toolUseId: string): ThreadEvent => ({ kind: "tool-result", toolUseId, isError: false, summary: "done" });
const turnEnd: ThreadEvent = { kind: "turn-end", costUsd: null, inputTokens: 0, outputTokens: 0, durationMs: 0 };

/** Stub the bridge, then import the component so the store loads against it (expert-chip.test.tsx's pattern). */
const load = async () => {
  vi.stubGlobal("window", { unskilled: { listExperts: vi.fn(async () => catalog) } });
  return import("../src/renderer/src/components/experts/TeamStrip");
};

/** React SSR separates adjacent text nodes with a comment; drop them before matching prose. */
const strip = (html: string): string => html.replace(/<!-- -->/g, "");

describe("activeMembers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tracks a member from its Agent tool-use to its tool-result", async () => {
    const { activeMembers } = await load();
    const ids = ["analyst", "writer"];
    expect([...activeMembers([toolUse("t1", "analyst")], ids)]).toEqual(["analyst"]);
    expect([...activeMembers([toolUse("t1", "analyst"), toolResult("t1")], ids)]).toEqual([]);
  });

  it("ignores a summary for an id that is not a member", async () => {
    const { activeMembers } = await load();
    expect([...activeMembers([toolUse("t1", "ghost")], ["analyst", "writer"])]).toEqual([]);
  });

  it("clears everything on a turn-end or an error", async () => {
    const { activeMembers } = await load();
    const ids = ["analyst", "writer"];
    expect([...activeMembers([toolUse("t1", "analyst"), turnEnd], ids)]).toEqual([]);
    expect([...activeMembers([toolUse("t1", "writer"), { kind: "error", message: "boom" }], ids)]).toEqual([]);
  });
});

describe("TeamStripView", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders nothing for an agent or a team with no members", async () => {
    const { TeamStripView } = await load();
    expect(renderToStaticMarkup(<TeamStripView def={agent} active={new Set<string>()} />)).toBe("");
    expect(renderToStaticMarkup(<TeamStripView def={def({ id: "empty-team", name: "Empty Team", kind: "team" })} active={new Set<string>()} />)).toBe("");
  });

  it("shows the lead, one item per member, and lights the working one", async () => {
    const { TeamStripView } = await load();
    const idle = strip(renderToStaticMarkup(<TeamStripView def={team} active={new Set<string>()} />));
    expect(idle).toContain('class="team-strip"');
    expect(idle).toContain('aria-label="Software Delivery Team team"');
    expect(idle).toContain(">Lead<");
    expect(idle.match(/class="team-strip-member/g)?.length).toBe(2);
    expect(idle).toContain("2 members");
    expect(idle).not.toContain("aria-current");

    const working = strip(renderToStaticMarkup(<TeamStripView def={team} active={new Set(["analyst"])} />));
    expect(working).toContain('class="team-strip-member active"');
    expect(working).toContain('aria-current="true"');
    expect(working).toContain("1 working");
  });

  it("lights the lead while the turn runs and no member is working", async () => {
    const { TeamStripView } = await load();
    const lead = strip(renderToStaticMarkup(<TeamStripView def={team} active={new Set<string>()} running />));
    expect(lead).toContain('class="team-strip-lead active"');
    expect(lead).toContain("Lead working");
    expect(lead.match(/class="beam"/g)?.length).toBe(1);
    // A member at work takes over: the lead waits.
    const member = strip(renderToStaticMarkup(<TeamStripView def={team} active={new Set(["writer"])} running />));
    expect(member).toContain('class="team-strip-lead"');
    expect(member).toContain("1 working");
    // Idle: nobody lit.
    const idle = strip(renderToStaticMarkup(<TeamStripView def={team} active={new Set<string>()} />));
    expect(idle).not.toContain("team-strip-lead active");
    expect(idle).not.toContain('class="beam"');
  });

  it("names what a member with its own model runs on, per agent", async () => {
    const { TeamStripView } = await load();
    const [analyst, writer] = team.members!;
    const own = { ...team, members: [{ ...analyst!, model: "haiku", effort: "low" as const }, writer!] };
    const claude = renderToStaticMarkup(<TeamStripView def={own} active={new Set<string>()} agent="claude" leadModel="opus" />);
    expect(claude).toContain('title="Data Analyst · Senior Data Analyst · haiku low"');
    expect(claude).toContain('title="Report Writer · Technical Writer"');
    const codex = renderToStaticMarkup(<TeamStripView def={own} active={new Set<string>()} agent="codex" leadModel="gpt-6" />);
    expect(codex).toContain("title=\"Data Analyst · Senior Data Analyst · gpt-6 low (uses the lead&#x27;s model on this agent)\"");
    // No agent known, or no member model: the tooltip is unchanged.
    expect(renderToStaticMarkup(<TeamStripView def={own} active={new Set<string>()} />)).toContain('title="Data Analyst · Senior Data Analyst"');
    expect(renderToStaticMarkup(<TeamStripView def={team} active={new Set<string>()} agent="claude" leadModel="opus" />)).toContain('title="Data Analyst · Senior Data Analyst"');
  });
});
