import { describe, expect, it } from "vitest";
import { COMPOSER_COMMANDS, matchCommands } from "../src/renderer/src/commands";

describe("COMPOSER_COMMANDS", () => {
  it("lists the permission modes, the model picker, context, mcp, compact, and a new thread", () => {
    expect(COMPOSER_COMMANDS.map((c) => c.name)).toEqual(["plan", "ask", "auto-edit", "full", "model", "context", "mcp", "compact", "new", "doctor"]);
  });
});

describe("matchCommands", () => {
  const names = (query: string) => matchCommands(query).map((c) => c.name);

  it("returns every command for an empty query, in order", () => {
    expect(names("")).toEqual(["plan", "ask", "auto-edit", "full", "model", "context", "mcp", "compact", "new", "doctor"]);
  });

  it("puts name-prefix matches before substring matches", () => {
    expect(names("n")).toEqual(["new", "plan", "context"]);
    expect(names("a")).toEqual(["ask", "auto-edit", "plan", "compact"]);
    expect(names("com")).toEqual(["compact"]);
  });

  it("matches case-insensitively on any part of the name", () => {
    expect(names("MOD")).toEqual(["model"]);
    expect(names("edit")).toEqual(["auto-edit"]);
  });

  it("returns nothing when no command matches", () => {
    expect(names("zzz")).toEqual([]);
  });
});
