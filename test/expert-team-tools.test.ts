import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PEER_NOTE_CAP,
  TEAM_BOARD_TOOL,
  TEAM_POST_TOOL,
  TEAM_READ_TOOL,
  TEAM_WRITE_TOOL,
  teamTools,
  type TeamNote,
} from "../src/main/experts/team";
import { tempDir } from "./helpers";

/** A fresh workspace with the four tools, a note log, and a fixed clock. */
function setup(opts: { members?: string[] } = {}) {
  const dir = tempDir();
  const notes: TeamNote[] = [];
  const tools = teamTools({
    dir,
    members: opts.members ?? ["researcher-1", "researcher-2"],
    onNote: (n) => notes.push(n),
    now: () => new Date(0),
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
    await run(TEAM_POST_TOOL, { from: "researcher-1", to: "researcher-2", text: "direct ping" });
    await run(TEAM_POST_TOOL, { from: "researcher-1", to: "all", text: "standup note" });
    await run(TEAM_POST_TOOL, { from: "researcher-2", to: "researcher-1", text: "reply" });
    await run(TEAM_POST_TOOL, { from: "researcher-2", to: "all", text: "progress" });

    const r1 = await run(TEAM_BOARD_TOOL, { for: "researcher-1" });
    expect(r1.isError).toBeFalsy();
    expect(r1.text).toBe(
      [
        `Workspace: ${dir}`,
        "Team: lead, researcher-1, researcher-2",
        "Unread notes (2):",
        "- researcher-2 → researcher-1: reply",
        "- researcher-2 → all: progress",
        "Files:",
        "- none",
      ].join("\n"),
    );

    const r2 = await run(TEAM_BOARD_TOOL, { for: "researcher-2" });
    expect(r2.text).toContain("Unread notes (2):");
    expect(r2.text).toContain("- researcher-1 → researcher-2: direct ping");
    expect(r2.text).toContain("- researcher-1 → all: standup note");

    // Reading marks the inbox read: the second board call has nothing new.
    const r1again = await run(TEAM_BOARD_TOOL, { for: "researcher-1" });
    expect(r1again.text).toContain("Unread notes (0):\n- none");
    expect(JSON.parse(readFileSync(join(dir, "cursors.json"), "utf8"))).toMatchObject({ "researcher-1": 5 });
  });

  it(`caps direct member-to-member notes at ${PEER_NOTE_CAP} until the lead posts again`, async () => {
    const { notes, run } = setup({ members: ["a", "b"] });
    for (let i = 0; i < PEER_NOTE_CAP; i++) {
      const res = await run(TEAM_POST_TOOL, { from: "a", to: "b", text: `ping ${i}` });
      expect(res.isError).toBeFalsy();
    }
    expect(notes.length).toBe(PEER_NOTE_CAP);

    const over = await run(TEAM_POST_TOOL, { from: "a", to: "b", text: "ping 6" });
    expect(over.isError).toBe(true);
    expect(over.text).toBe("Direct-note limit reached for this round; report to the lead instead.");
    expect(notes.length).toBe(PEER_NOTE_CAP);

    // A note from the lead starts a new round, so a→b works again.
    expect((await run(TEAM_POST_TOOL, { from: "lead", to: "b", text: "carry on" })).isError).toBeFalsy();
    expect((await run(TEAM_POST_TOOL, { from: "a", to: "b", text: "fresh round" })).isError).toBeFalsy();
    expect(notes.length).toBe(PEER_NOTE_CAP + 2);
  });

  it("never counts posts between members and the lead against the cap", async () => {
    const { run } = setup({ members: ["a", "b"] });
    for (let i = 0; i < 7; i++) {
      expect((await run(TEAM_POST_TOOL, { from: "lead", to: "a", text: `task ${i}` })).isError).toBeFalsy();
      expect((await run(TEAM_POST_TOOL, { from: "b", to: "lead", text: `report ${i}` })).isError).toBeFalsy();
    }
    expect((await run(TEAM_POST_TOOL, { from: "a", to: "b", text: "still allowed" })).isError).toBeFalsy();
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

    await run(TEAM_POST_TOOL, { from: "researcher-1", to: "all", text: "valid note" });
    appendFileSync(join(dir, "notes.jsonl"), "{corrupt\n");
    writeFileSync(join(dir, "cursors.json"), "{corrupt");

    const board = await run(TEAM_BOARD_TOOL, { for: "researcher-2" });
    expect(board.isError).toBeFalsy();
    expect(board.text).toContain("Unread notes (1):");
    expect(board.text).toContain("- researcher-1 → all: valid note");
    expect(JSON.parse(readFileSync(join(dir, "cursors.json"), "utf8"))).toMatchObject({ "researcher-2": 1 });
  });
});
