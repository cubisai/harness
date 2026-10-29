import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExpertCatalog } from "../src/main/experts/catalog";
import { expertBlock, expertFromMarkdown, parseExpertMarkdown, TEAM_LEAD_PROTOCOL, teamAgents, teamMemberProtocol } from "../src/shared/experts";
import { tempDir } from "./helpers";

describe("parseExpertMarkdown", () => {
  it("reads an inline list, stripping quotes", () => {
    const { meta, body } = parseExpertMarkdown('---\nid: ui\ntags: [a, b, "c d"]\n---\nThe body.\n', "fallback");
    expect(meta.id).toBe("ui");
    expect(meta.tags).toEqual(["a", "b", "c d"]);
    expect(body).toBe("The body.");
  });

  it("keeps a comma inside a quoted list item", () => {
    const { meta } = parseExpertMarkdown('---\nquickPrompts: ["Turn this into a design, code plan and test plan", \'a, b\', c]\n---\n', "fallback");
    expect(meta.quickPrompts).toEqual(["Turn this into a design, code plan and test plan", "a, b", "c"]);
  });

  it("reads an indented dash list", () => {
    const text = "---\nname: X\ntags:\n  - one\n  - two\n---\nBody\n";
    const { meta } = parseExpertMarkdown(text, "fallback");
    expect(meta.tags).toEqual(["one", "two"]);
  });

  it("handles CRLF line endings", () => {
    const { meta, body } = parseExpertMarkdown("---\r\nid: crlf\r\nname: CRLF\r\n---\r\nBody here.\r\n", "fallback");
    expect(meta.id).toBe("crlf");
    expect(body).toBe("Body here.");
  });

  it("treats text with no frontmatter as all body", () => {
    const { meta, body } = parseExpertMarkdown("Just markdown.\n\nMore.", "fallback");
    expect(meta).toEqual({});
    expect(body).toBe("Just markdown.\n\nMore.");
  });
});

describe("expertFromMarkdown", () => {
  const good = '---\nname: Ada\n---\nYou are Ada.';

  it("rejects a bad id", () => {
    expect(expertFromMarkdown("---\nid: Bad_ID!\nname: Ada\n---\nBody", "fallback", "builtin")).toBeNull();
  });

  it("rejects a missing name", () => {
    expect(expertFromMarkdown("---\nid: ada\n---\nBody", "fallback", "builtin")).toBeNull();
  });

  it("rejects an empty body", () => {
    expect(expertFromMarkdown("---\nid: ada\nname: Ada\n---\n\n", "fallback", "builtin")).toBeNull();
  });

  it("falls back to the given id and defaults the rest", () => {
    const def = expertFromMarkdown(good, "fallback", "builtin");
    expect(def).toMatchObject({ id: "fallback", name: "Ada", kind: "agent", category: "General", avatarText: "AD", version: "1.0.0", source: "builtin" });
    expect(def?.prompt).toBe("You are Ada.");
    expect(def).not.toHaveProperty("sourceUrl");
    expect(def).not.toHaveProperty("license");
  });

  it("reads an imported expert's source, author and license", () => {
    const def = expertFromMarkdown("---\nname: Ada\nsourceUrl: https://github.com/a/b\nauthor: Ann\nlicense: none\n---\nYou are Ada.", "ada", "imported");
    expect(def).toMatchObject({ sourceUrl: "https://github.com/a/b", author: "Ann", license: "none" });
  });
});

describe("createExpertCatalog", () => {
  it("lists a bundled single file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "solo.md"), "---\nname: Solo\nprofession: Writer\n---\nWrite.\n");
    const catalog = createExpertCatalog({ bundledDir: dir, userDir: join(dir, "user") });
    const list = catalog.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "solo", name: "Solo", source: "builtin" });
    expect(list[0]!.path).toBe(join(dir, "solo.md"));
    expect(catalog.get("solo")?.name).toBe("Solo");
  });

  it("lists a bundled team folder with two members", () => {
    const dir = tempDir();
    const team = join(dir, "crew");
    mkdirSync(join(team, "members"), { recursive: true });
    writeFileSync(join(team, "expert.md"), "---\nname: Crew\nkind: team\n---\nLead the crew.\n");
    writeFileSync(join(team, "members", "writer.md"), "---\nname: Wren\nprofession: Writer\ndescription: Writes.\nskills: [prose]\n---\nWrite it.\n");
    writeFileSync(join(team, "members", "editor.md"), "---\nname: Ed\nprofession: Editor\ndescription: Edits.\n---\nEdit it.\n");
    const catalog = createExpertCatalog({ bundledDir: dir, userDir: join(dir, "user") });
    const def = catalog.get("crew");
    expect(def?.kind).toBe("team");
    expect(def?.members?.map((m) => m.id).sort()).toEqual(["editor", "writer"]);
    expect(def?.members?.find((m) => m.id === "writer")).toMatchObject({ name: "Wren", profession: "Writer", prompt: "Write it.", skills: ["prose"] });
  });

  it("lets an imported expert override a bundled id", () => {
    const bundled = tempDir();
    const user = tempDir();
    writeFileSync(join(bundled, "shared.md"), "---\nname: Bundled\n---\nBundled body.\n");
    mkdirSync(join(user, "shared"), { recursive: true });
    writeFileSync(join(user, "shared", "expert.md"), "---\nname: Imported\n---\nImported body.\n");
    const catalog = createExpertCatalog({ bundledDir: bundled, userDir: user });
    const list = catalog.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "shared", name: "Imported", source: "imported" });
  });

  it("returns null for an unknown id", () => {
    const dir = tempDir();
    const catalog = createExpertCatalog({ bundledDir: dir, userDir: join(dir, "user") });
    expect(catalog.get("nope")).toBeNull();
    expect(catalog.list()).toEqual([]);
  });

  it("finds a folder expert's own skills folder, and none for a bare file or no folder", () => {
    const bundled = tempDir();
    const userDir = tempDir();
    writeFileSync(join(bundled, "solo.md"), "---\nname: Solo\n---\nBody.\n");
    mkdirSync(join(userDir, "pkg", "skills", "tool-a"), { recursive: true });
    writeFileSync(join(userDir, "pkg", "expert.md"), "---\nname: Pkg\n---\nBody.\n");
    writeFileSync(join(userDir, "pkg", "skills", "tool-a", "SKILL.md"), "---\nname: tool-a\ndescription: A tool\n---\nbody\n");
    mkdirSync(join(userDir, "plain"), { recursive: true });
    writeFileSync(join(userDir, "plain", "expert.md"), "---\nname: Plain\n---\nBody.\n");
    const catalog = createExpertCatalog({ bundledDir: bundled, userDir });
    expect(catalog.skillsDir("pkg")).toBe(join(userDir, "pkg", "skills"));
    expect(catalog.skillsDir("plain")).toBeNull();
    expect(catalog.skillsDir("solo")).toBeNull();
    expect(catalog.skillsDir("missing")).toBeNull();
  });
});

describe("expertBlock", () => {
  it("wraps the prompt, escapes quotes in attributes and ends with the Stay line", () => {
    const block = expertBlock({ name: 'Ada "The" One', profession: "Writer", prompt: "You write.", kind: "agent", members: undefined });
    expect(block).toBe('<expert name="Ada &quot;The&quot; One" role="Writer">\nYou write.\n</expert>\n\nStay Ada "The" One, Writer, for this whole thread.');
  });

  it("says Stay without a role when the expert has no profession", () => {
    const block = expertBlock({ name: "Solo", profession: "", prompt: "Write.", kind: "agent", members: undefined });
    expect(block.endsWith("\n\nStay Solo for this whole thread.")).toBe(true);
  });

  it("lists team members, the lead protocol and then the Stay line", () => {
    const block = expertBlock({
      name: "Crew",
      profession: "Lead",
      prompt: "Lead.",
      kind: "team",
      members: [{ id: "writer", name: "Wren", profession: "Writer", description: "Writes.", prompt: "p", skills: [] }],
    });
    expect(block).toContain("## Your team");
    expect(block).toContain("- `writer` — Wren, Writer: Writes.");
    expect(block.endsWith(`${TEAM_LEAD_PROTOCOL}\n\nStay Crew, Lead, for this whole thread.`)).toBe(true);
  });

  it("tells the lead to size a request before delegating, and what a brief holds (P6.2)", () => {
    // Small asks are answered directly, narrow ones go to one member, phases only on dependencies.
    expect(TEAM_LEAD_PROTOCOL).toContain("Answer a quick question, a clarification or a follow-up on results you already have yourself");
    expect(TEAM_LEAD_PROTOCOL).toContain("a narrow ask goes to one member, never the whole team");
    expect(TEAM_LEAD_PROTOCOL).toContain("Use phases only when a step needs another member's result");
    expect(TEAM_LEAD_PROTOCOL).not.toContain("Plan the work as phases");
    for (const part of ["the objective", "the inputs", "the expected outcome", "the evidence to include", "the boundaries", "when to stop"]) expect(TEAM_LEAD_PROTOCOL).toContain(part);
    expect(TEAM_LEAD_PROTOCOL).toContain("Give a dependent member those file names instead of retelling the results");
    expect(teamMemberProtocol("writer")).toContain("the outcome, the evidence it rests on, the file name and open questions");
  });
});

describe("teamAgents", () => {
  const member = (id: string, extra: Partial<{ description: string; prompt: string }> = {}) => ({ id, name: `N-${id}`, profession: "Analyst", description: "Finds facts.", prompt: "Research.", skills: [], ...extra });

  it("turns a team's members into subagents, in order", () => {
    expect(teamAgents({ kind: "team", members: [member("analyst"), member("writer", { description: "" })] })).toEqual([
      { id: "analyst", description: "N-analyst, Analyst: Finds facts.", prompt: `Research.\n\n${teamMemberProtocol("analyst")}` },
      { id: "writer", description: "N-writer, Analyst", prompt: `Research.\n\n${teamMemberProtocol("writer")}` },
    ]);
  });

  it("has none for a single expert or a team without members", () => {
    expect(teamAgents({ kind: "agent", members: [member("analyst")] })).toEqual([]);
    expect(teamAgents({ kind: "team", members: undefined })).toEqual([]);
  });

  it("leaves out engine agent names, bad and duplicate ids, and empty prompts", () => {
    const team = [member("general-purpose"), member("build"), member("Bad Id"), member("analyst"), member("analyst"), member("blank", { prompt: "  " })];
    expect(teamAgents({ kind: "team", members: team }).map((a) => a.id)).toEqual(["analyst"]);
  });
});
