import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAiSyncedSkills, skillFolders } from "../src/main/skills/folders";
import { tempDir } from "./helpers";

const skill = (dir: string, name: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
};

describe("skillFolders", () => {
  it("finds folders holding a SKILL.md, symlinked ones too, and skips the rest", () => {
    const home = tempDir();
    const real = tempDir();
    skill(home, "plain");
    skill(real, "linked");
    symlinkSync(join(real, "linked"), join(home, "linked"), "junction");
    mkdirSync(join(home, "synced", "acct", "docs"), { recursive: true });
    expect(skillFolders([home, join(home, "missing")]).sort()).toEqual(["linked", "plain"]);
  });
});

describe("claudeAiSyncedSkills", () => {
  it("lists the skills synced under each claude.ai account once, minus names that are real skills elsewhere", () => {
    const claude = tempDir();
    const agents = tempDir();
    skill(join(claude, "synced", "a1"), "morning");
    skill(join(claude, "synced", "a1"), "docx");
    skill(join(claude, "synced", "a2"), "morning");
    skill(join(claude, "synced", "a2"), "agent-browser");
    skill(agents, "agent-browser");
    skill(claude, "docx");
    writeFileSync(join(claude, "synced", "manifest.json"), "{}");
    expect(claudeAiSyncedSkills(claude, [agents])).toEqual(["morning"]);
  });

  it("is empty without a synced folder", () => {
    expect(claudeAiSyncedSkills(tempDir(), [])).toEqual([]);
  });
});
