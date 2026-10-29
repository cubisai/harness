import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexCoveredSkills, enabledCodexPlugins, withoutCodexCovered } from "../src/main/skills/codex-plugins";
import type { SkillEntry } from "../src/shared/types";

const CONFIG = `model = "gpt-6-luna"
[plugins."browser@openai-bundled"]
enabled = true

[plugins."documents@openai-primary-runtime"]
enabled = true # the Codex app turns these on

[plugins."spreadsheets@openai-primary-runtime"]
enabled = false

# [plugins."pdf@openai-primary-runtime"]
# enabled = true

[plugins.presentations]
enabled = true

[mcp_servers.x]
enabled = true
`;

const entry = (name: string, origin: SkillEntry["origin"]) => ({ name, origin }) as SkillEntry;

describe("enabledCodexPlugins", () => {
  it("lists the plugins a config.toml enables, by name without the marketplace, skipping disabled and commented ones", () => {
    expect([...enabledCodexPlugins(CONFIG)].sort()).toEqual(["browser", "documents", "presentations"]);
    expect(enabledCodexPlugins("").size).toBe(0);
  });
});

describe("codexCoveredSkills", () => {
  it("names the bundled skills Codex's enabled document plugins cover, from CODEX_HOME's config.toml", () => {
    const read = (file: string) => {
      expect(file).toBe(join("/codex-home", "config.toml"));
      return CONFIG;
    };
    expect([...codexCoveredSkills({ CODEX_HOME: "/codex-home" }, read)].sort()).toEqual(["docx", "pptx"]);
  });

  it("covers nothing when the config can't be read (a CLI-only install without the plugins)", () => {
    const read = () => {
      throw new Error("ENOENT");
    };
    expect(codexCoveredSkills({ CODEX_HOME: "/none" }, read).size).toBe(0);
  });
});

describe("withoutCodexCovered", () => {
  it("drops only the bundled skill of a covered name; a project skill of that name stays", () => {
    const skills = [entry("docx", "bundled"), entry("pdf", "bundled"), entry("docx", "project"), entry("browser", "bundled")];
    expect(withoutCodexCovered(skills, new Set(["docx"]))).toEqual([entry("pdf", "bundled"), entry("docx", "project"), entry("browser", "bundled")]);
  });

  it("returns the same list when nothing is covered", () => {
    const skills = [entry("docx", "bundled")];
    expect(withoutCodexCovered(skills, new Set())).toBe(skills);
  });
});
