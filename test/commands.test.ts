import { describe, expect, it } from "vitest";
import { COMPOSER_COMMANDS, exactCommand, isCommandSkill, issueCommand, matchCommands } from "../src/renderer/src/commands";

describe("COMPOSER_COMMANDS", () => {
  it("lists plan mode, the model picker, the issue picker, context, mcp, compact, a new thread, doctor and code mode (the other modes live on the mode chip)", () => {
    expect(COMPOSER_COMMANDS.map((c) => c.name)).toEqual(["plan", "model", "issue", "issue-setup", "triage", "pr", "context", "mcp", "compact", "new", "doctor", "codemode"]);
  });
});

describe("matchCommands", () => {
  const names = (query: string) => matchCommands(query).map((c) => c.name);

  it("returns every command for an empty query, in order", () => {
    expect(names("")).toEqual(["plan", "model", "issue", "issue-setup", "triage", "pr", "context", "mcp", "compact", "new", "doctor", "codemode"]);
  });

  it("puts name-prefix matches before substring matches", () => {
    expect(names("n")).toEqual(["new", "plan", "context"]);
    expect(names("a")).toEqual(["plan", "triage", "compact"]);
    expect(names("com")).toEqual(["compact"]);
  });

  it("matches case-insensitively on any part of the name", () => {
    expect(names("MOD")).toEqual(["model", "codemode"]);
    expect(names("edit")).toEqual([]);
  });

  it("returns nothing when no command matches", () => {
    expect(names("zzz")).toEqual([]);
  });
});

describe("exactCommand", () => {
  it("names the command a bare /name runs, so a Tab-completed \"/issue \" still runs on Enter", () => {
    expect(exactCommand("/issue ")?.name).toBe("issue");
    expect(exactCommand(" /new")?.name).toBe("new");
    expect(exactCommand("/issue Login fails")).toBeNull();
    expect(exactCommand("/iss")).toBeNull();
    expect(exactCommand("issue")).toBeNull();
  });
});

describe("issue commands", () => {
  it("runs the issue skills with their argument; a bare /issue is the picker", () => {
    expect(issueCommand("/issue")).toBeNull();
    expect(issueCommand("/issue Login fails on Windows")).toEqual({ skill: "issue", args: "Login fails on Windows" });
    expect(issueCommand("/issue-setup")).toEqual({ skill: "issue-setup", args: "" });
    expect(issueCommand(" /triage move 12 to ready-for-agent ")).toEqual({ skill: "triage", args: "move 12 to ready-for-agent" });
    expect(issueCommand("/pr")).toEqual({ skill: "pr", args: "" });
    expect(issueCommand("/issues")).toBeNull();
    expect(issueCommand("fix /pr")).toBeNull();
  });

  it("keeps only the bundled issue skills out of the $ menus", () => {
    expect(isCommandSkill({ name: "triage", origin: "bundled" })).toBe(true);
    expect(isCommandSkill({ name: "pr", origin: "project" })).toBe(false);
    expect(isCommandSkill({ name: "tdd", origin: "bundled" })).toBe(false);
  });
});
