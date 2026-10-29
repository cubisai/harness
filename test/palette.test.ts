import { describe, expect, it } from "vitest";
import { newThreadCommands, rankCommands, type Command } from "../src/renderer/src/palette";

const cmd = (section: Command["section"], title: string, extra: Partial<Command> = {}): Command => ({
  id: `${section}:${title}`,
  section,
  title,
  run: () => {},
  ...extra,
});

const commands: Command[] = [
  cmd("Actions", "New Thread", { shortcut: "⌘N" }),
  cmd("Actions", "Show Terminal", { keywords: "shell console" }),
  cmd("Actions", "Settings…", { keywords: "preferences api keys" }),
  cmd("Skills", "/implement", { detail: "Build a ticket or a small change, test-first." }),
  cmd("Skills", "/implement-spec", { detail: "Implement a whole spec on one branch." }),
  ...Array.from({ length: 7 }, (_, i) => cmd("Threads", `Thread ${i}`, { detail: "acme-web" })),
  cmd("Projects", "acme-web"),
];

const titles = (list: Command[]) => list.map((c) => c.title);

describe("rankCommands", () => {
  it("shows actions and the five most recent threads for an empty query", () => {
    expect(titles(rankCommands(commands, ""))).toEqual([
      "New Thread",
      "Show Terminal",
      "Settings…",
      "Thread 0",
      "Thread 1",
      "Thread 2",
      "Thread 3",
      "Thread 4",
    ]);
  });

  it("needs every word, and matches keywords and details", () => {
    expect(titles(rankCommands(commands, "shell"))).toEqual(["Show Terminal"]);
    expect(titles(rankCommands(commands, "api keys"))).toEqual(["Settings…"]);
    expect(titles(rankCommands(commands, "test-first"))).toEqual(["/implement"]);
    expect(rankCommands(commands, "terminal nope")).toEqual([]);
  });

  it("ranks title prefixes first, and ignores a leading slash", () => {
    expect(titles(rankCommands(commands, "/impl"))).toEqual(["/implement", "/implement-spec"]);
    expect(titles(rankCommands(commands, "acme")).at(0)).toBe("acme-web");
    expect(titles(rankCommands(commands, "thread"))).toEqual(["Thread 0", "Thread 1", "Thread 2", "Thread 3", "Thread 4", "Thread 5", "Thread 6", "New Thread"]);
  });

  it("lists only actions for a query starting with >", () => {
    expect(titles(rankCommands(commands, ">"))).toEqual(["New Thread", "Show Terminal", "Settings…"]);
    expect(titles(rankCommands(commands, ">new"))).toEqual(["New Thread"]);
    expect(titles(rankCommands(commands, ">  settings"))).toEqual(["Settings…"]);
    expect(rankCommands(commands, ">impl")).toEqual([]);
    expect(titles(rankCommands(commands, "new"))).toContain("New Thread");
    expect(titles(rankCommands(commands, "impl"))).toEqual(["/implement", "/implement-spec"]);
  });
});

describe("newThreadCommands", () => {
  it("lists New Thread and New Thread in Worktree, which asks for a worktree", () => {
    const calls: [string[] | undefined, { worktree?: boolean } | undefined][] = [];
    const list = newThreadCommands({ enabled: true, shortcut: "⌘N", newThread: (skill, opts) => calls.push([skill, opts]) });
    expect(list.map((c) => c.title)).toEqual(["New Thread", "New Thread in Worktree"]);
    list[0]!.run();
    list[1]!.run();
    expect(calls).toEqual([
      [undefined, undefined],
      [undefined, { worktree: true }],
    ]);
  });

  it("offers nothing with no project open", () => {
    expect(newThreadCommands({ enabled: false, shortcut: "⌘N", newThread: () => {} })).toEqual([]);
  });
});
