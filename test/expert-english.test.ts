import { describe, expect, it } from "vitest";
import { cjkChars, englishPass, hasCjk, type Translate } from "../src/main/experts/english";

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function dec(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A package with three skills and one member file built from `front` + `body`. */
function memberFiles(front: string[], body: string): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["skills/deep-research-agent/SKILL.md", enc("# Deep research")],
    ["skills/market-insight/SKILL.md", enc("# Market insight")],
    ["skills/other/SKILL.md", enc("# Other")],
    ["members/a.md", enc(`---\n${front.join("\n")}\n---\n\n${body}\n`)],
  ]);
}

describe("hasCjk", () => {
  it("is true for Han text and false for English", () => {
    expect(hasCjk("\u7814\u7a76")).toBe(true);
    expect(hasCjk("research")).toBe(false);
  });
});

describe("englishPass junk filter", () => {
  it("drops tooling files silently and keeps .env.example", async () => {
    const files = new Map<string, Uint8Array>([
      [".workbuddy/x", enc("noise")],
      ["skills/s/reports/r.html", enc("<p>noise</p>")],
      ["skills/s/.env", enc("SECRET=1")],
      ["skills/s/.env.example", enc("KEY=value")],
    ]);
    const res = await englishPass(files, {});
    expect([...res.files.keys()]).toEqual(["skills/s/.env.example"]);
    expect(res.dropped).toEqual([]);
  });
});

describe("englishPass translation", () => {
  it("translates a Chinese member file and counts it", async () => {
    const calls: { path: string; text: string }[][] = [];
    const translate: Translate = async (items) => {
      calls.push(items);
      return items.map((item) => item.text.replace(/\u7814\u7a76\u5458/g, "Researcher").replace(/\u6df1\u5ea6\u7814\u7a76/g, "Deep research"));
    };
    const files = new Map<string, Uint8Array>([
      ["members/a.md", enc("---\nname: \u7814\u7a76\u5458\nprofession: \u7814\u7a76\u5458\n---\n\n\u7814\u7a76\u5458 runs \u6df1\u5ea6\u7814\u7a76.")],
    ]);
    const res = await englishPass(files, { translate });
    expect(res.translated).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]!.map((item) => item.path)).toEqual(["members/a.md"]);
    const text = dec(res.files.get("members/a.md")!);
    expect(text).toContain("name: Researcher");
    expect(text).toContain("profession: Researcher");
    expect(text).toContain("Researcher runs Deep research.");
    expect(res.files.has("members/a.md")).toBe(true);
  });

  it("closes a batch when the next file would exceed batchChars", async () => {
    let calls = 0;
    const translate: Translate = async (items) => {
      calls++;
      return items.map(() => "Translated text.");
    };
    const files = new Map<string, Uint8Array>([
      ["a.txt", enc("\u7814\u7a76".repeat(20))],
      ["b.txt", enc("\u7814\u7a76".repeat(20))],
    ]);
    const res = await englishPass(files, { translate, batchChars: 50 });
    expect(calls).toBe(2);
    expect(res.translated).toBe(2);
  });
});

describe("englishPass gate", () => {
  it("drops a member file that is still Chinese", async () => {
    const files = new Map<string, Uint8Array>([["members/a.md", enc("---\nname: a\n---\n\u8fd8\u6709\u4e2d\u6587\u3002")]]);
    const res = await englishPass(files, {});
    expect(res.dropped).toContain("members/a.md");
    expect(res.files.has("members/a.md")).toBe(false);
  });

  it("drops a Chinese skill reference and reports the skill as partial", async () => {
    const files = new Map<string, Uint8Array>([
      ["skills/s/SKILL.md", enc("# Skill s\n\nDo the thing.")],
      ["skills/s/references/r.md", enc("\u4e2d\u6587 reference")],
    ]);
    const res = await englishPass(files, {});
    expect(res.dropped).toContain("skills/s/references/r.md");
    expect(res.partialSkills).toEqual(["s"]);
    expect(res.files.has("skills/s/SKILL.md")).toBe(true);
    expect(res.files.has("skills/s/references/r.md")).toBe(false);
  });

  it("removes the whole skill when its SKILL.md is Chinese", async () => {
    const files = new Map<string, Uint8Array>([
      ["skills/t/SKILL.md", enc("\u4e2d\u6587 skill")],
      ["skills/t/references/x.md", enc("English reference")],
      ["skills/t/scripts/run.py", enc("# english")],
    ]);
    const res = await englishPass(files, {});
    expect(res.files.has("skills/t/SKILL.md")).toBe(false);
    expect(res.files.has("skills/t/references/x.md")).toBe(false);
    expect(res.files.has("skills/t/scripts/run.py")).toBe(false);
    expect(res.dropped).toEqual(["skills/t/SKILL.md"]);
    expect(res.partialSkills).toEqual(["t"]);
  });

  it("throws when expert.md is still Chinese", async () => {
    const files = new Map<string, Uint8Array>([["expert.md", enc("\u4e2d\u6587 prompt")]]);
    await expect(englishPass(files, {})).rejects.toThrow("This expert is written in Chinese and could not be translated to English, so it was not installed.");
  });
});

describe("englishPass member binding", () => {
  it("binds the package skills named in the body, in order of first occurrence", async () => {
    const res = await englishPass(memberFiles(["name: a", "profession: Analyst", "description: Does the work."], "Run `deep-research-agent`, then use market-insight."), {});
    const text = dec(res.files.get("members/a.md")!);
    expect(text).toContain("skills: [deep-research-agent, market-insight]");
    expect(text).not.toContain("other");
  });

  it("keeps an explicit skills list as-is", async () => {
    const res = await englishPass(memberFiles(["name: a", "description: Does the work.", "skills: [other]"], "Body text."), {});
    const text = dec(res.files.get("members/a.md")!);
    expect(text).toContain("skills: [other]");
  });

  it("fills an empty description from the first prose paragraph", async () => {
    const res = await englishPass(memberFiles(["name: a"], "# Title\n\nYou verify facts. More text."), {});
    const text = dec(res.files.get("members/a.md")!);
    expect(text).toContain("description: You verify facts\n");
  });
});

describe("englishPass Skill tool rewrite", () => {
  it("rewrites a quoted package skill on a Skill tool line", async () => {
    const files = new Map<string, Uint8Array>([
      ["skills/market-insight/SKILL.md", enc("# Market insight")],
      ["expert.md", enc('---\nid: x\n---\nCall the Skill tool with "market-insight".\nA plain mention: "market-insight".')],
    ]);
    const res = await englishPass(files, {});
    const text = dec(res.files.get("expert.md")!);
    expect(text).toContain("Call the Skill tool with the `market-insight` skill from your skills list.");
    expect(text).toContain('A plain mention: "market-insight".');
  });
});

describe("cjkChars", () => {
  it("counts only CJK-bearing text files", () => {
    const files = new Map<string, Uint8Array>([
      ["a.md", enc("\u7814\u7a76")],
      ["b.md", enc("research")],
      ["c.png", enc("\u7814\u7a76")],
    ]);
    expect(cjkChars(files)).toBe(2);
  });
});

describe("englishPass maxTurns", () => {
  it("keeps a member's maxTurns when it re-renders the frontmatter", async () => {
    const files = new Map<string, Uint8Array>([["members/a.md", enc("---\nname: A\nprofession: P\ndescription: D\nmaxTurns: 100\n---\n\nDo A.")]]);
    const out = new TextDecoder().decode((await englishPass(files, {})).files.get("members/a.md")!);
    expect(out).toContain("maxTurns: 100");
  });
});
