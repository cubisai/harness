import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TEAM_BOARD_TOOL,
  TEAM_POST_TOOL,
  TEAM_READ_TOOL,
  TEAM_WRITE_TOOL,
  latestFileBy,
  readTeamFile,
  teamTools,
  type TeamNote,
} from "../src/main/experts/team";
import { tempDir } from "./helpers";

/** A fresh workspace with the four tools, a note log, and a fixed clock (or a ticking one). */
function setup(opts: { members?: string[]; now?: () => Date } = {}) {
  const dir = tempDir();
  const notes: TeamNote[] = [];
  const tools = teamTools({
    dir,
    members: opts.members ?? ["researcher-1", "researcher-2"],
    onNote: (n) => notes.push(n),
    now: opts.now ?? (() => new Date(0)),
  });
  const run = (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`No tool named ${name}`);
    return tool.run(args);
  };
  return { dir, notes, run };
}

describe("expert team tools", () => {
  it("round-trips a saved result through team_write and team_read", async () => {
    const { dir, notes, run } = setup();
    const saved = await run(TEAM_WRITE_TOOL, { from: "researcher-1", name: "findings-1", content: "hello team" });
    expect(saved.isError).toBeFalsy();
    expect(saved.text).toBe(`Saved findings-1 (10 chars) at ${join(dir, "findings-1.md")}.`);
    expect(readFileSync(join(dir, "findings-1.md"), "utf8")).toBe("hello team");

    const read = await run(TEAM_READ_TOOL, { name: "findings-1" });
    expect(read.isError).toBeFalsy();
    expect(read.text).toBe("hello team");
    expect(notes).toEqual([]);
  });

  it("errors on a missing file and on invalid file names", async () => {
    const { run } = setup();
    const missing = await run(TEAM_READ_TOOL, { name: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe("No file named nope. Call team_board to list the workspace.");

    const badNames = ["sub/path", "BAD", "-nope", "x".repeat(65)];
    for (const bad of badNames) {
      expect((await run(TEAM_READ_TOOL, { name: bad })).isError).toBe(true);
      const saved = await run(TEAM_WRITE_TOOL, { from: "researcher-1", name: bad, content: "x" });
      expect(saved.isError).toBe(true);
      expect(saved.text).toBe("Use a short lowercase name like researcher-1 (letters, digits, hyphens).");
    }
  });

  it("errors on unknown member ids, listing the team", async () => {
    const { run } = setup();
    const expected = 'Unknown team member "ghost". Team: lead, researcher-1, researcher-2.';
    expect((await run(TEAM_WRITE_TOOL, { from: "ghost", name: "findings-1", content: "x" })).text).toBe(expected);
    expect((await run(TEAM_POST_TOOL, { from: "ghost", to: "lead", text: "hi" })).text).toBe(expected);
    expect((await run(TEAM_POST_TOOL, { from: "lead", to: "ghost", text: "hi" })).text).toBe(expected);
    expect((await run(TEAM_BOARD_TOOL, { for: "ghost" })).text).toBe(expected);
  });

  it("refuses posting to yourself", async () => {
    const { notes, run } = setup();
    const res = await run(TEAM_POST_TOOL, { from: "researcher-1", to: "researcher-1", text: "note to self" });
    expect(res.isError).toBe(true);
    expect(res.text).toBe("You can't post to yourself.");
    expect(notes).toEqual([]);
  });

  it("caps a note at 600 characters and requires non-empty text", async () => {
    const { run } = setup();
    const res = await run(TEAM_POST_TOOL, { from: "researcher-1", to: "lead", text: "x".repeat(601) });
    expect(res.isError).toBe(true);
    expect(res.text).toBe("Keep a note under 600 characters; save longer text with team_write and point to it.");
    expect((await run(TEAM_POST_TOOL, { from: "researcher-1", to: "lead", text: "   " })).isError).toBe(true);
  });

  it("reports each accepted note through onNote and notes.jsonl", async () => {
    const { dir, notes, run } = setup();
    const note = { at: new Date(0).toISOString(), from: "researcher-1", to: "lead", text: "done with step 1" };
    const res = await run(TEAM_POST_TOOL, { from: "researcher-1", to: "lead", text: "done with step 1" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toBe("Sent to lead.");
    expect(notes).toEqual([note]);
    expect(JSON.parse(readFileSync(join(dir, "notes.jsonl"), "utf8").trim())).toEqual(note);
  });

  it("boards unread notes addressed to the reader or all, then none after", async () => {
    const { dir, run } = setup();
    await run(TEAM_POST_TOOL, { from: "researcher-1", to: "lead", text: "hello lead" });
    await run(TEAM_POST_TOOL, { from: "researcher-2", to: "lead", text: "reply" });
    await run(TEAM_POST_TOOL, { from: "lead", to: "researcher-2", text: "direct ping" });
    await run(TEAM_POST_TOOL, { from: "lead", to: "all", text: "standup note" });
    await run(TEAM_POST_TOOL, { from: "lead", to: "researcher-1", text: "for you" });

    const r1 = await run(TEAM_BOARD_TOOL, { for: "researcher-1" });
    expect(r1.isError).toBeFalsy();
    expect(r1.text).toBe(
      [
        `Workspace: ${dir}`,
        "Team: lead, researcher-1, researcher-2",
        "Unread notes (2):",
        "- lead → all: standup note",
        "- lead → researcher-1: for you",
        "Files:",
        "- none",
      ].join("\n"),
    );

    const r2 = await run(TEAM_BOARD_TOOL, { for: "researcher-2" });
    expect(r2.text).toContain("Unread notes (2):");
    expect(r2.text).toContain("- lead → researcher-2: direct ping");
    expect(r2.text).toContain("- lead → all: standup note");

    // Reading marks the inbox read: the second board call has nothing new.
    const r1again = await run(TEAM_BOARD_TOOL, { for: "researcher-1" });
    expect(r1again.text).toContain("Unread notes (0):\n- none");
    expect(JSON.parse(readFileSync(join(dir, "cursors.json"), "utf8"))).toMatchObject({ "researcher-1": 5 });
  });

  it("lets a member post to the lead alone, never to a member or all", async () => {
    const { notes, run } = setup();
    const expected = 'Members report to the lead only: post with to: "lead".';
    const peer = await run(TEAM_POST_TOOL, { from: "researcher-1", to: "researcher-2", text: "ping" });
    expect(peer.isError).toBe(true);
    expect(peer.text).toBe(expected);
    const broadcast = await run(TEAM_POST_TOOL, { from: "researcher-1", to: "all", text: "ping all" });
    expect(broadcast.isError).toBe(true);
    expect(broadcast.text).toBe(expected);
    expect(notes).toEqual([]);

    const toLead = await run(TEAM_POST_TOOL, { from: "researcher-1", to: "lead", text: "done" });
    expect(toLead.isError).toBeFalsy();
    expect(toLead.text).toBe("Sent to lead.");
    expect(notes).toHaveLength(1);
  });

  it("lets the lead post to one member or to all", async () => {
    const { notes, run } = setup();
    const toMember = await run(TEAM_POST_TOOL, { from: "lead", to: "researcher-2", text: "task" });
    expect(toMember.isError).toBeFalsy();
    expect(toMember.text).toBe("Sent to researcher-2.");
    const toAll = await run(TEAM_POST_TOOL, { from: "lead", to: "all", text: "standup" });
    expect(toAll.isError).toBeFalsy();
    expect(toAll.text).toBe("Sent to all.");
    expect(notes.map((n) => n.to)).toEqual(["researcher-2", "all"]);
  });

  it("lists workspace files sorted by name with character counts", async () => {
    const { run } = setup();
    await run(TEAM_WRITE_TOOL, { from: "researcher-1", name: "zebra", content: "zz" });
    await run(TEAM_WRITE_TOOL, { from: "researcher-2", name: "alpha", content: "aaa" });
    const board = await run(TEAM_BOARD_TOOL, { for: "lead" });
    expect(board.text).toContain("Files:\n- alpha (3 chars)\n- zebra (2 chars)");
  });

  it("truncates a long file read at 20000 characters", async () => {
    const { run } = setup();
    await run(TEAM_WRITE_TOOL, { from: "researcher-1", name: "big", content: "x".repeat(25000) });
    const read = await run(TEAM_READ_TOOL, { name: "big" });
    expect(read.isError).toBeFalsy();
    expect(read.text).toBe(`${"x".repeat(20000)}\n\n[truncated: 25000 chars total]`);
  });

  it("boards an empty workspace without error and skips corrupt log lines and cursors", async () => {
    const { dir, run } = setup();
    const empty = await run(TEAM_BOARD_TOOL, { for: "lead" });
    expect(empty.isError).toBeFalsy();
    expect(empty.text).toContain("Unread notes (0):\n- none");
    expect(empty.text).toContain("Files:\n- none");

    await run(TEAM_POST_TOOL, { from: "lead", to: "all", text: "valid note" });
    appendFileSync(join(dir, "notes.jsonl"), "{corrupt\n");
    writeFileSync(join(dir, "cursors.json"), "{corrupt");

    const board = await run(TEAM_BOARD_TOOL, { for: "researcher-2" });
    expect(board.isError).toBeFalsy();
    expect(board.text).toContain("Unread notes (1):");
    expect(board.text).toContain("- lead → all: valid note");
    expect(JSON.parse(readFileSync(join(dir, "cursors.json"), "utf8"))).toMatchObject({ "researcher-2": 1 });
  });

  it("records who wrote each file and finds a member's newest one", async () => {
    let t = 0;
    const { dir, run } = setup({ now: () => new Date(++t * 1000) });
    expect(latestFileBy(dir, "researcher-1")).toBeNull();
    await run(TEAM_WRITE_TOOL, { from: "researcher-1", name: "dana-facts-a", content: "a" });
    await run(TEAM_WRITE_TOOL, { from: "researcher-2", name: "other", content: "b" });
    await run(TEAM_WRITE_TOOL, { from: "researcher-1", name: "dana-facts-b", content: "c" });
    expect(latestFileBy(dir, "researcher-1")).toBe("dana-facts-b");
    expect(latestFileBy(dir, "researcher-2")).toBe("other");
    // Rewriting an older file makes it the newest.
    await run(TEAM_WRITE_TOOL, { from: "researcher-1", name: "dana-facts-a", content: "a2" });
    expect(latestFileBy(dir, "researcher-1")).toBe("dana-facts-a");
    expect(readTeamFile(dir, "dana-facts-a")).toBe("a2");
    expect(readTeamFile(dir, "../index")).toBeNull();
    // A corrupt index finds nothing instead of throwing.
    writeFileSync(join(dir, "index.json"), "{not json");
    expect(latestFileBy(dir, "researcher-1")).toBeNull();
  });
});
