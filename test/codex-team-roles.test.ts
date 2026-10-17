import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexTeamRoles } from "../src/main/agents/codex";
import { tempDir } from "./helpers";

describe("codexTeamRoles", () => {
  const team = [
    { id: "checker", description: "Checker: Checks facts.", prompt: 'Check "quoted" facts.\nLine two \\ done.' },
    { id: "writer", description: "Writer", prompt: "Write." },
  ];

  it("writes one role file per member and returns this thread's agents table", () => {
    const dir = join(tempDir(), "t1");
    const roles = codexTeamRoles(team, dir);
    expect(Object.keys(roles)).toEqual(["checker", "writer"]);
    expect(roles.checker).toEqual({ description: "Checker: Checks facts.", config_file: join(dir, "checker.toml") });
    const toml = readFileSync(join(dir, "checker.toml"), "utf8");
    // A TOML basic string: quotes, newlines and backslashes escaped.
    expect(toml).toBe('developer_instructions = "Check \\"quoted\\" facts.\\nLine two \\\\ done."\n');
  });

  it("leaves an unchanged role file alone", () => {
    const dir = join(tempDir(), "t2");
    codexTeamRoles(team, dir);
    const before = statSync(join(dir, "writer.toml")).mtimeMs;
    codexTeamRoles(team, dir);
    expect(statSync(join(dir, "writer.toml")).mtimeMs).toBe(before);
  });

  it("adds the step budget sentence to a member with maxTurns", () => {
    const dir = join(tempDir(), "t3");
    codexTeamRoles([{ id: "researcher", description: "Researcher", prompt: "Find facts.", maxTurns: 5 }], dir);
    const toml = readFileSync(join(dir, "researcher.toml"), "utf8");
    expect(toml).toBe('developer_instructions = "Find facts.\\n\\nFinish your step within 5 tool calls, then reply to the lead."\n');
  });

  it("leaves a member without maxTurns at exactly the member prompt", () => {
    const dir = join(tempDir(), "t4");
    codexTeamRoles(team, dir);
    expect(readFileSync(join(dir, "writer.toml"), "utf8")).toBe('developer_instructions = "Write."\n');
  });
});
