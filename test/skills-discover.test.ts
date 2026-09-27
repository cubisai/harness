import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SkillEntry } from "../src/shared/types";
import { mergeCatalog, type Catalog } from "../src/main/skills/catalog";
import { discoverSkills, parseSkillMd } from "../src/main/skills/discover";
import { forAgent } from "../src/main/skills/sources";
import { skillTool } from "../src/main/skills/tool";
import { startToolServer } from "../src/main/mcp-http";
import type { HarnessTool } from "../src/main/agents/types";
import { closeAfter, tempDir } from "./helpers";

function writeSkill(root: string, name: string, text: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
  return dir;
}

function entry(name: string, origin: SkillEntry["origin"], over: Partial<SkillEntry> = {}): SkillEntry {
  return { name, description: `${name} desc`, invocation: "model", calls: [], files: [], sha256: name, origin, ...over };
}

describe("parseSkillMd", () => {
  it("parses CRLF frontmatter and strips the block from the body", () => {
    const parsed = parseSkillMd("---\r\nname: alpha\r\ndescription: \"Do the thing\"\r\nuser-invocable: false\r\n---\r\n\r\nBody line\r\n");
    expect(parsed.name).toBe("alpha");
    expect(parsed.description).toBe("Do the thing");
    expect(parsed.userInvocable).toBe(false);
    expect(parsed.disableModelInvocation).toBe(false);
    expect(parsed.body).toBe("Body line\n");
  });

  it("parses quotes and booleans, and a quoted argument hint", () => {
    const parsed = parseSkillMd(`---\nname: 'quoted name'\ndescription: with quotes\ndisable-model-invocation: true\nargument-hint: "[ticket or spec]"\n---\nbody`);
    expect(parsed.name).toBe("quoted name");
    expect(parsed.disableModelInvocation).toBe(true);
    expect(parsed.argumentHint).toBe("[ticket or spec]");
    expect(parsed.userInvocable).toBe(true);
    expect(parsed.body).toBe("body");
  });

  it("treats a file with no frontmatter as body only", () => {
    const parsed = parseSkillMd("# Title\n\nJust text");
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.disableModelInvocation).toBe(false);
    expect(parsed.userInvocable).toBe(true);
    expect(parsed.body).toBe("# Title\n\nJust text");
  });
});

describe("discoverSkills", () => {
  it("returns nothing for a missing directory", () => {
    expect(discoverSkills({ origin: "harness", dir: join(tempDir(), "nope") })).toEqual([]);
  });

  it("finds SKILL.md folders and skips the ones with no description or no file", () => {
    const dir = tempDir();
    writeSkill(dir, "alpha", "---\nname: alpha\ndescription: Alpha skill\n---\nbody");
    writeSkill(dir, "beta", "---\nname: beta\ndescription: \"\"\n---\nbody");
    writeSkill(dir, "no-md", "no skill file here");
    const skills = discoverSkills({ origin: "project", dir });
    expect(skills.map((s) => s.name)).toEqual(["alpha"]);
    const alpha = skills[0]!;
    expect(alpha.description).toBe("Alpha skill");
    expect(alpha.origin).toBe("project");
    expect(alpha.dir).toBe(join(dir, "alpha"));
    expect(alpha.invocation).toBe("model");
    expect(alpha.userInvocable).toBe(true);
    expect(alpha.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to the folder name and defaults a model skill", () => {
    const dir = tempDir();
    writeSkill(dir, "folder-name", "---\ndescription: No name field\n---\nbody");
    const [skill] = discoverSkills({ origin: "shared", dir });
    expect(skill!.name).toBe("folder-name");
    expect(skill!.invocation).toBe("model");
  });
});

describe("mergeCatalog", () => {
  const project = [
    entry("dup", "project"),
    entry("solo", "project"),
    entry("run", "project", { invocation: "user", userInvocable: false }),
  ];
  const harness = [entry("dup", "harness")];
  const legacy = [entry("old", "legacy")];

  it("takes the first name and marks lower duplicates shadowed", () => {
    const cat = mergeCatalog([project, harness, legacy], new Set());
    expect(cat.byName.get("dup")!.origin).toBe("project");
    expect(cat.skills.map((s) => s.name).sort()).toEqual(["dup", "old", "run", "solo"]);
    const shadowed = cat.all.find((s) => s.name === "dup" && s.origin === "harness");
    expect(shadowed!.shadowedBy).toBe("project");
    expect(cat.all).toHaveLength(5);
  });

  it("disables an entry by origin:name, keeping it in all", () => {
    const cat = mergeCatalog([project, harness, legacy], new Set(["project:solo"]));
    expect(cat.byName.has("solo")).toBe(false);
    expect(cat.skills.some((s) => s.name === "solo")).toBe(false);
    const solo = cat.all.find((s) => s.name === "solo");
    expect(solo!.enabled).toBe(false);
  });

  it("keeps model-invoked skills in userSkills so the / menu can start them", () => {
    const cat = mergeCatalog([project, harness, legacy], new Set());
    expect(cat.userSkills.map((s) => s.name).sort()).toEqual(["dup", "old", "solo"]);
    expect(cat.modelSkills.map((s) => s.name).sort()).toEqual(["dup", "old", "solo"]);
    // user-invocable: false still shows for model delivery, but not in the menu.
    expect(cat.userSkills.some((s) => s.name === "run")).toBe(false);
    expect(cat.skills.some((s) => s.name === "run")).toBe(true);
  });
});

describe("forAgent", () => {
  const catalog: Catalog = mergeCatalog(
    [[entry("p", "project"), entry("h", "harness"), entry("s", "shared")], [entry("l", "legacy")]],
    new Set(),
  );

  it("drops the origins the agent reads natively", () => {
    expect(forAgent(catalog, { mode: "tool", reads: ["project", "shared"] }).map((s) => s.name).sort()).toEqual(["h", "l"]);
    expect(forAgent(catalog, { mode: "extraRoots", reads: [] }).map((s) => s.name).sort()).toEqual(["h", "l", "p", "s"]);
    expect(forAgent(catalog, { mode: "none" }).map((s) => s.name).sort()).toEqual(["h", "l", "p", "s"]);
  });
});

describe("skillTool", () => {
  function fixture(): SkillEntry[] {
    const dir = tempDir();
    writeSkill(dir, "alpha", "---\ndescription: Alpha does a thing\n---\nAlpha body");
    writeSkill(dir, "zeta", "---\ndescription: Zeta does another\n---\nZeta body");
    return discoverSkills({ origin: "harness", dir });
  }

  it("lists the skills in the description, sorted", () => {
    const skills = fixture();
    const tool = skillTool(() => skills);
    expect(tool.name).toBe("skill");
    expect(tool.autoAllow).toBe(true);
    expect(tool.description).toContain("Load a skill");
    expect(tool.description.indexOf("- alpha:")).toBeLessThan(tool.description.indexOf("- zeta:"));
  });

  it("says so when there are none", () => {
    expect(skillTool(() => []).description).toBe("No skills are installed.");
  });

  it("returns the body and base for a known skill", async () => {
    const skills = fixture();
    const tool = skillTool(() => skills);
    const out = await tool.run({ name: "alpha" });
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain('<skill name="alpha" base="');
    expect(out.text).toContain("Alpha body");
  });

  it("errors with the list for an unknown skill", async () => {
    const skills = fixture();
    const tool = skillTool(() => skills);
    const out = await tool.run({ name: "missing" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("alpha");
    expect(out.text).toContain("zeta");
  });
});

describe("startToolServer routes", () => {
  const echo: HarnessTool = {
    name: "echo",
    description: "Echo",
    input: { text: z.string() },
    autoAllow: true,
    run: async () => ({ text: "ok" }),
  };
  const extra: HarnessTool = {
    name: "skill",
    description: "Load a skill",
    input: { name: z.string() },
    autoAllow: true,
    run: async () => ({ text: "ok" }),
  };

  async function names(url: string, token: string): Promise<string[]> {
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name);
  }

  it("serves /mcp without the extra tools and /mcp-skills with them", async () => {
    const server = await startToolServer(() => [echo], () => [extra]);
    closeAfter(() => void server.close());
    expect(await names(server.url, server.token)).toEqual(["echo"]);
    expect(await names(server.skillsUrl, server.token)).toEqual(["echo", "skill"]);
  });

  it("404s any other path", async () => {
    const server = await startToolServer(() => [echo]);
    closeAfter(() => void server.close());
    const res = await fetch(`http://127.0.0.1:${new URL(server.url).port}/other`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("forAgent native names", () => {
  it("drops a skill the agent already loads from its own folder", async () => {
    const { forAgent } = await import("../src/main/skills/sources");
    const { mergeCatalog } = await import("../src/main/skills/catalog");
    const entry = (name: string) => ({ name, description: "d", invocation: "model" as const, calls: [], files: [], sha256: "x", origin: "shared" as const, dir: `/s/${name}` });
    const catalog = mergeCatalog([[entry("agent-browser"), entry("docx")]], new Set());
    const names = forAgent(catalog, { mode: "plugin", reads: [] }, new Set(["agent-browser"])).map((s) => s.name);
    expect(names).toEqual(["docx"]);
  });
});
