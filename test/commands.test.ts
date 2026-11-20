import { describe, expect, it } from "vitest";
import { COMPOSER_COMMANDS, exactCommand, isCommandSkill, issueCommand, matchCommands, pluginSkillSelections, selectedPluginCommand } from "../src/renderer/src/commands";
import type { SkillEntry } from "../src/shared/types";
import { pluginCommandArguments } from "../src/shared/plugin-parts";

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

describe("reviewed plugin command selection", () => {
  const command = { command: "notes.review", key: "g~notes", name: "review", revision: "one", description: "Review notes" };
  it("offers qualified commands after built-ins without stealing a reserved name", () => {
    expect(matchCommands("", [command]).slice(-1)[0]).toEqual({ name: "notes.review", description: "Review notes", plugin: { key: "g~notes", name: "review", revision: "one" } });
    expect(matchCommands("notes", [command])).toHaveLength(1);
    expect(matchCommands("", [{ ...command, command: "plan" }])).toEqual(COMPOSER_COMMANDS);
    expect(exactCommand("/notes.review")).toBeNull();
  });
  it("selection is pure and pins the old reviewed identity across Off/Update", () => {
    const selected = selectedPluginCommand("/notes.review extra arguments", [command]);
    expect(selected).toEqual({ key: "g~notes", name: "review", revision: "one" });
    expect(selectedPluginCommand("/notes.review edited", [{ ...command, revision: "two" }], selected)).toEqual(selected);
    expect(selectedPluginCommand("/notes.review", [], selected)).toEqual(selected);
    expect(() => selectedPluginCommand("/notes.unknown", [command])).toThrow("unavailable");
    expect(() => selectedPluginCommand("/NOTES.review", [command])).toThrow("unavailable");
    expect(selectedPluginCommand("ordinary message", [command], selected)).toBeNull();
  });
  it("pins plugin skill ownership only; standalone skills keep existing semantics", () => {
    const owned = { name: "p-notes-review", origin: "plugin", owner: { key: "g~notes", title: "Notes", enabled: true, revision: "one" } } as SkillEntry;
    expect(pluginSkillSelections([owned])).toEqual({ pluginSkills: [{ key: "g~notes", name: owned.name, revision: "one" }] });
    expect(pluginSkillSelections([{ ...owned, origin: "project" }])).toEqual({});
    expect(() => pluginSkillSelections([{ ...owned, owner: undefined }])).toThrow("unavailable");
  });
  it("strips only the selected qualified prefix from prompt arguments, preserving ordinary API text", () => {
    expect(pluginCommandArguments(" /notes.review extra\ncontext", "notes.review")).toBe("extra\ncontext");
    expect(pluginCommandArguments("/notes.review", "notes.review")).toBe("");
    expect(pluginCommandArguments("/notes.review-other", "notes.review")).toBe("/notes.review-other");
    expect(pluginCommandArguments("ordinary arguments", "notes.review")).toBe("ordinary arguments");
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
