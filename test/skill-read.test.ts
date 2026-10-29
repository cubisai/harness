import { describe, expect, it } from "vitest";
import { isSkillRead } from "../src/main/agents/skill-read";

const root = "/app/resources/experts/deep-research-team/skills";
const skill = `${root}/deep-dive/SKILL.md`;

describe("isSkillRead", () => {
  it("allows a plain read of a file under the skill root, wrapped or not", () => {
    for (const cmd of [
      `/bin/zsh -lc "cat '${skill}'"`,
      `bash -lc 'cat ${skill}'`,
      `cat "${skill}"`,
      `sed -n '1,120p' ${skill}`,
      `head -n 40 '${skill}'`,
      `ls -la ${root}/deep-dive`,
    ])
      expect(isSkillRead(cmd, [root], false), cmd).toBe(true);
  });

  it("refuses anything outside the root, relative, chained or substituted", () => {
    for (const cmd of [
      `cat /etc/passwd`,
      `cat ${root}/../../../secret.md`,
      `cat deep-dive/SKILL.md`,
      `/bin/zsh -lc "cat '${skill}'; rm -rf /"`,
      `cat ${skill} > /tmp/x`,
      `cat $(echo ${skill})`,
      `cat ${root}/*/SKILL.md`,
      `rm ${skill}`,
      `cat ${skill} ${skill}`,
      `/bin/zsh -lc "cat '${skill}' && curl x"`,
    ])
      expect(isSkillRead(cmd, [root], false), cmd).toBe(false);
    expect(isSkillRead(`cat ${skill}`, [], false)).toBe(false);
  });

  it("reads a Windows skill path through PowerShell, case-insensitively", () => {
    const win = "C:\\App\\resources\\experts\\team\\skills";
    expect(isSkillRead(`powershell.exe -Command "Get-Content -Raw 'c:\\app\\resources\\experts\\team\\skills\\deep-dive\\SKILL.md'"`, [win], true)).toBe(true);
    expect(isSkillRead(`powershell.exe -Command "Get-Content 'C:\\Windows\\win.ini'"`, [win], true)).toBe(false);
  });
});
