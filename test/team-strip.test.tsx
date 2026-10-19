/// <reference types="vite/client" />
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExpertDef } from "../src/shared/experts";
import type { MemberRun } from "../src/shared/team-runs";
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

describe("doneMembers", () => {
  afterEach(() => vi.unstubAllGlobals());
  const user: ThreadEvent = { kind: "user", text: "next" };

  it("counts members whose handoff finished since the last user message", async () => {
    const { doneMembers } = await load();
    const ids = ["analyst", "writer"];
    expect([...doneMembers([toolUse("t1", "analyst"), toolResult("t1"), toolUse("t2", "writer")], ids)]).toEqual(["analyst"]);
    // A new user message starts a new turn's count.
    expect([...doneMembers([toolUse("t1", "analyst"), toolResult("t1"), turnEnd, user], ids)]).toEqual([]);
    // Other tool results don't count.
    expect([...doneMembers([toolResult("x")], ids)]).toEqual([]);
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
    // Progress once a member finished; finished-and-rebriefed counts as working.
    expect(strip(renderToStaticMarkup(<TeamStripView def={team} active={new Set(["writer"])} done={new Set(["analyst"])} running />))).toContain("1 working · 1 of 2 done");
    expect(strip(renderToStaticMarkup(<TeamStripView def={team} active={new Set<string>()} done={new Set(["analyst", "writer"])} running />))).toContain("Lead working · 2 of 2 done");
    expect(strip(renderToStaticMarkup(<TeamStripView def={team} active={new Set(["analyst"])} done={new Set(["analyst"])} running />))).toContain(">1 working<");
    // Idle: nobody lit, no progress.
    expect(strip(renderToStaticMarkup(<TeamStripView def={team} active={new Set<string>()} done={new Set(["analyst"])} />))).toContain("2 members");
    const idle = strip(renderToStaticMarkup(<TeamStripView def={team} active={new Set<string>()} />));
    expect(idle).not.toContain("team-strip-lead active");
    expect(idle).not.toContain('class="beam"');
  });

  it("names what a member with its own model runs on, per agent", async () => {
    const { TeamStripView } = await load();
    const [analyst, writer] = team.members!;
    const own = { ...team, members: [{ ...analyst!, model: "haiku", effort: "low" as const }, writer!] };
    const claude = renderToStaticMarkup(<TeamStripView def={own} active={new Set<string>()} agent="claude" leadModel="opus" />);
    expect(claude).toContain('title="Data Analyst · Senior Data Analyst · haiku low · open latest result"');
    expect(claude).toContain('title="Report Writer · Technical Writer · open latest result"');
    const codex = renderToStaticMarkup(<TeamStripView def={own} active={new Set<string>()} agent="codex" leadModel="gpt-6" />);
    expect(codex).toContain("title=\"Data Analyst · Senior Data Analyst · gpt-6 low (uses the lead&#x27;s model on this agent) · open latest result\"");
    // No agent known, or no member model: the tooltip is unchanged.
    expect(renderToStaticMarkup(<TeamStripView def={own} active={new Set<string>()} />)).toContain('title="Data Analyst · Senior Data Analyst · open latest result"');
    expect(renderToStaticMarkup(<TeamStripView def={team} active={new Set<string>()} agent="claude" leadModel="opus" />)).toContain('title="Data Analyst · Senior Data Analyst · open latest result"');
  });

  it("shows a member's latest runs in its title, newest first, capped at 3", async () => {
    const { TeamStripView } = await load();
    const run = (toolUseId: string, status: MemberRun["status"], durationMs: number): MemberRun => ({ memberId: "analyst", toolUseId, status, startedAt: 0, endedAt: durationMs, durationMs, summary: "", usage: null });
    const runs = [run("t1", "done", 1000), run("t2", "done", 2000), run("t3", "failed", 3000), run("t4", "done", 4000)];
    const html = strip(renderToStaticMarkup(<TeamStripView def={team} active={new Set<string>()} runs={runs} />));
    expect(html).toContain('title="Data Analyst · Senior Data Analyst · done · 4.0 s; failed · 3.0 s; done · 2.0 s (+1 earlier) · open latest result"');
    // A member with no runs keeps its plain title.
    expect(html).toContain('title="Report Writer · Technical Writer · open latest result"');
  });
});
