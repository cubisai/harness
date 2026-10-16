import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { importExperts, parseSource, removeImportedExpert } from "../src/main/experts/importer";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cubiq-imp-"));
  dirs.push(d);
  return d;
}

/** Write one file under `root`, creating parents. */
function put(root: string, rel: string, content: string | Uint8Array): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** A single-agent CodeBuddy plugin tree under a fresh temp folder. */
function agentPlugin(root: string): void {
  put(
    root,
    ".codebuddy-plugin/plugin.json",
    JSON.stringify({
      name: "Code Reviewer",
      version: "1.2.0",
      description: "Plain description.",
      author: { name: "Acme" },
      agents: ["./agents/wen.md"],
      skills: ["./skills/review"],
      expertType: "agent",
      agentName: "Wen",
      displayName: { en: "Wen Reviewer", zh: "文" },
      profession: { en: "Code Reviewer", zh: "代码审查员" },
      displayDescription: { en: "Reads every line.", zh: "逐行阅读。" },
      avatar: "avatars/wen.png",
      categoryId: "02-Engineering",
      defaultInitPrompt: { en: "Review my diff", zh: "审查我的改动" },
      tags: [{ en: "review" }, { en: "quality" }],
      quickPrompts: [{ en: "Review my diff" }, { en: "Check the tests" }],
    }),
  );
  put(
    root,
    "agents/wen.md",
    ["---", "name: Wen", "description: Lead reviewer", "displayName:", '  en: "Wen"', '  zh: "文"', "profession:", '  en: "Code Reviewer"', "maxTurns: 30", "---", "You are Wen, a reviewer."].join("\n"),
  );
  put(root, "skills/review/SKILL.md", "---\nname: review\ndescription: Review a diff.\n---\nDo the review.");
  put(root, "skills/review/references/checklist.md", "- be kind");
  put(root, "avatars/wen.png", new Uint8Array([137, 80, 78, 71]));
}

/** A minimal fetch Response stand-in; avoids depending on real header rules. */
function fakeResponse(body: Uint8Array, init: { status?: number; contentLength?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-length" && init.contentLength !== undefined ? String(init.contentLength) : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  } as unknown as Response;
}

describe("parseSource", () => {
  it("accepts a github root", () => {
    expect(parseSource("https://github.com/acme/expert-pack")).toEqual({ kind: "github", owner: "acme", repo: "expert-pack", ref: null, subpath: "" });
  });

  it("accepts a github tree ref and subpath", () => {
    expect(parseSource("https://github.com/acme/expert-pack/tree/main/plugins/x")).toEqual({
      kind: "github",
      owner: "acme",
      repo: "expert-pack",
      ref: "main",
      subpath: "plugins/x",
    });
  });

  it("strips a .git suffix", () => {
    expect(parseSource("https://github.com/acme/expert-pack.git")).toEqual({ kind: "github", owner: "acme", repo: "expert-pack", ref: null, subpath: "" });
  });

  it("rejects http, other hosts and relative paths", () => {
    expect(parseSource("http://github.com/acme/expert-pack")).toBeNull();
    expect(parseSource("https://gitlab.com/acme/expert-pack")).toBeNull();
    expect(parseSource("./local/folder")).toBeNull();
    expect(parseSource("")).toBeNull();
  });

  it("accepts an absolute folder and a .zip, rejects traversal", () => {
    expect(parseSource("/tmp/some/package")).toEqual({ kind: "folder", path: "/tmp/some/package" });
    expect(parseSource("/tmp/some/package.zip")).toEqual({ kind: "zip", path: "/tmp/some/package.zip" });
    expect(parseSource("/tmp/../etc/passwd")).toBeNull();
  });
});

describe("folder import", () => {
  it("imports a single-agent plugin into CubiQ markdown", async () => {
    const src = tempDir();
    const userDir = tempDir();
    agentPlugin(src);
    const result = await importExperts(src, { userDir });
    expect(result.installed).toEqual(["code-reviewer"]);

    const expert = readFileSync(join(userDir, "code-reviewer", "expert.md"), "utf-8");
    expect(expert).toContain("id: code-reviewer");
    expect(expert).toContain("kind: agent");
    expect(expert).toContain("name: Wen Reviewer");
    expect(expert).toContain("persona: Wen");
    expect(expert).toContain("category: Engineering");
    expect(expert).toContain("avatar: WE");
    expect(expert).toContain("description: Reads every line.");
    expect(expert).toContain('tags: ["review","quality"]');
    expect(expert).toContain('quickPrompts: ["Review my diff","Check the tests"]');
    expect(expert).toContain('skills: ["review"]');
    expect(expert).toContain("version: 1.2.0");
    expect(expert).toContain("author: Acme");
    expect(expert.endsWith("You are Wen, a reviewer.\n")).toBe(true);

    expect(existsSync(join(userDir, "code-reviewer", "skills", "review", "SKILL.md"))).toBe(true);
    expect(existsSync(join(userDir, "code-reviewer", "skills", "review", "references", "checklist.md"))).toBe(true);
    expect(existsSync(join(userDir, "code-reviewer", "avatar.png"))).toBe(true);
  });

  it("imports each agents/*.md of a bare root as its own expert", async () => {
    const src = tempDir();
    const userDir = tempDir();
    put(src, "agents/alpha.md", "---\nname: Alpha\n---\nAlpha body.");
    put(src, "agents/beta.md", "---\nname: Beta\n---\nBeta body.");
    const result = await importExperts(src, { userDir });
    expect(result.installed.sort()).toEqual(["alpha", "beta"]);
    expect(readFileSync(join(userDir, "alpha", "expert.md"), "utf-8")).toContain("Alpha body.");
  });
});

describe("team import", () => {
  it("writes a members file per memberAgent", async () => {
    const src = tempDir();
    const userDir = tempDir();
    put(
      src,
      ".codebuddy-plugin/plugin.json",
      JSON.stringify({
        name: "Growth Team",
        agents: ["./agents/lead.md", "./agents/member.md"],
        expertType: "team",
        teamInfo: { leadAgent: "Lead", memberAgents: ["Member"] },
        displayName: { en: "Growth Team" },
        categoryId: "04-DataAI",
      }),
    );
    put(src, "agents/lead.md", "---\nname: Lead\n---\nLead body.");
    put(src, "agents/member.md", "---\nname: Member\ndisplayName: Member One\nprofession: Analyst\n---\nMember body.");

    const result = await importExperts(src, { userDir });
    expect(result.installed).toEqual(["growth-team"]);
    const expert = readFileSync(join(userDir, "growth-team", "expert.md"), "utf-8");
    expect(expert).toContain("kind: team");
    expect(expert).toContain("category: Data & AI");
    expect(expert.endsWith("Lead body.\n")).toBe(true);
    const member = readFileSync(join(userDir, "growth-team", "members", "member.md"), "utf-8");
    expect(member).toContain("name: Member One");
    expect(member).toContain("profession: Analyst");
    expect(member.endsWith("Member body.\n")).toBe(true);
  });
});

describe("marketplace import", () => {
  function marketplace(root: string): void {
    put(root, ".codebuddy-plugin/marketplace.json", JSON.stringify({ name: "Pack", plugins: [{ name: "Alpha Expert", source: "./plugins/alpha", description: "First." }] }));
    put(
      root,
      "plugins/alpha/.codebuddy-plugin/plugin.json",
      JSON.stringify({ name: "Alpha Expert", agents: ["./agents/a.md"], displayName: { en: "Alpha Expert" } }),
    );
    put(root, "plugins/alpha/agents/a.md", "---\nname: A\n---\nAlpha body.");
  }

  it("lists candidates without installing when no pick is given", async () => {
    const src = tempDir();
    const userDir = tempDir();
    marketplace(src);
    const result = await importExperts(src, { userDir });
    expect(result.candidates).toEqual([{ name: "Alpha Expert", description: "First.", root: "plugins/alpha" }]);
    expect(result.installed).toEqual([]);
    expect(existsSync(join(userDir, "alpha-expert"))).toBe(false);
  });

  it("installs only the picked plugin", async () => {
    const src = tempDir();
    const userDir = tempDir();
    marketplace(src);
    const result = await importExperts(src, { userDir, pick: ["Alpha Expert"] });
    expect(result.installed).toEqual(["alpha-expert"]);
    expect(readFileSync(join(userDir, "alpha-expert", "expert.md"), "utf-8")).toContain("Alpha body.");
  });

  it("re-picks a plugin by the expert id it installed as (an update)", async () => {
    const src = tempDir();
    const userDir = tempDir();
    marketplace(src);
    const result = await importExperts(src, { userDir, pick: ["alpha-expert"] });
    expect(result.installed).toEqual(["alpha-expert"]);
    expect(result.skipped).toEqual([]);
  });
});

describe("zip import", () => {
  async function buildZip(files: Record<string, string>): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    return zip.generateAsync({ type: "uint8array" });
  }

  it("imports a zip with a shared top-level folder", async () => {
    const pkg = tempDir();
    put(pkg, ".codebuddy-plugin/plugin.json", JSON.stringify({ name: "Zipped Expert", agents: ["./agents/z.md"], displayName: { en: "Zipped Expert" } }));
    put(pkg, "agents/z.md", "---\nname: Z\n---\nZip body.");
    const bytes = await buildZip({
      "pack/.codebuddy-plugin/plugin.json": readFileSync(join(pkg, ".codebuddy-plugin/plugin.json"), "utf-8"),
      "pack/agents/z.md": readFileSync(join(pkg, "agents/z.md"), "utf-8"),
    });
    const zipPath = join(tempDir(), "pack.zip");
    writeFileSync(zipPath, bytes);
    const userDir = tempDir();
    const result = await importExperts(zipPath, { userDir });
    expect(result.installed).toEqual(["zipped-expert"]);
    expect(readFileSync(join(userDir, "zipped-expert", "expert.md"), "utf-8")).toContain("Zip body.");
  });

  it("rejects a zip-slip entry and writes nothing", async () => {
    const bytes = await buildZip({
      "pack/.codebuddy-plugin/plugin.json": JSON.stringify({ name: "Evil", agents: ["./agents/e.md"] }),
      "pack/agents/e.md": "---\nname: E\n---\nbody",
      "../evil.md": "pwned",
    });
    const zipPath = join(tempDir(), "evil.zip");
    writeFileSync(zipPath, bytes);
    const userDir = tempDir();
    await expect(importExperts(zipPath, { userDir })).rejects.toThrow(/Unsafe path/);
    expect(existsSync(join(userDir, "evil"))).toBe(false);
  });
});

describe("github import", () => {
  it("fetches a zipball, strips the archive folder and honours a subpath", async () => {
    const pkg = tempDir();
    put(pkg, ".codebuddy-plugin/plugin.json", JSON.stringify({ name: "Remote Expert", agents: ["./agents/r.md"], displayName: { en: "Remote Expert" } }));
    put(pkg, "agents/r.md", "---\nname: R\n---\nRemote body.");
    const zip = new JSZip();
    zip.file("acme-pack-abc123/plugins/x/.codebuddy-plugin/plugin.json", readFileSync(join(pkg, ".codebuddy-plugin/plugin.json"), "utf-8"));
    zip.file("acme-pack-abc123/plugins/x/agents/r.md", readFileSync(join(pkg, "agents/r.md"), "utf-8"));
    const bytes = await zip.generateAsync({ type: "uint8array" });

    let seen = "";
    const fakeFetch = (async (url: string) => {
      seen = url;
      return fakeResponse(bytes);
    }) as unknown as typeof fetch;

    const userDir = tempDir();
    const result = await importExperts("https://github.com/acme/pack/tree/main/plugins/x", { userDir, fetch: fakeFetch });
    expect(seen).toContain("/zipball/main");
    expect(result.installed).toEqual(["remote-expert"]);
    expect(readFileSync(join(userDir, "remote-expert", "expert.md"), "utf-8")).toContain("Remote body.");
  });

  it("throws on an over-size content-length", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fakeFetch = (async () => fakeResponse(bytes, { contentLength: 10_000_000 })) as unknown as typeof fetch;
    await expect(importExperts("https://github.com/acme/pack", { userDir: tempDir(), fetch: fakeFetch, maxBytes: 1000 })).rejects.toThrow(/too large/);
  });

  it("refuses a non-2xx response", async () => {
    const fakeFetch = (async () => fakeResponse(new Uint8Array(), { status: 404 })) as unknown as typeof fetch;
    await expect(importExperts("https://github.com/acme/pack", { userDir: tempDir(), fetch: fakeFetch })).rejects.toThrow(/404/);
  });
});

describe("license detection", () => {
  it("reads an SPDX-ish id from a LICENSE file", async () => {
    const src = tempDir();
    const userDir = tempDir();
    agentPlugin(src);
    put(src, "LICENSE", "MIT License\n\nPermission is hereby granted...");
    await importExperts(src, { userDir });
    expect(readFileSync(join(userDir, "code-reviewer", "expert.md"), "utf-8")).toContain("license: MIT");
  });

  it("defaults to none without a LICENSE", async () => {
    const src = tempDir();
    const userDir = tempDir();
    agentPlugin(src);
    await importExperts(src, { userDir });
    expect(readFileSync(join(userDir, "code-reviewer", "expert.md"), "utf-8")).toContain("license: none");
  });
});

describe("removeImportedExpert", () => {
  it("removes the expert folder", async () => {
    const src = tempDir();
    const userDir = tempDir();
    agentPlugin(src);
    await importExperts(src, { userDir });
    expect(existsSync(join(userDir, "code-reviewer"))).toBe(true);
    removeImportedExpert(userDir, "code-reviewer");
    expect(existsSync(join(userDir, "code-reviewer"))).toBe(false);
  });

  it("rejects a traversal id", () => {
    expect(() => removeImportedExpert(tempDir(), "../x")).toThrow();
  });
});

describe("English-only display fields", () => {
  it("never writes Chinese names, roles, tags or prompts", async () => {
    const root = mkdtempSync(join(tmpdir(), "cubiq-imp-"));
    const userDir = mkdtempSync(join(tmpdir(), "cubiq-imp-"));
    mkdirSync(join(root, ".codebuddy-plugin"), { recursive: true });
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(
      join(root, ".codebuddy-plugin", "plugin.json"),
      JSON.stringify({
        name: "research-crew",
        expertType: "team",
        agentName: "crew-lead",
        agents: ["./agents/crew-lead.md", "./agents/fact-checker.md"],
        teamInfo: { leadAgent: "crew-lead", memberAgents: ["fact-checker"] },
        displayName: { zh: "研究小队" },
        profession: { zh: "研究团队" },
        tags: [{ zh: "深度调研" }, { en: "Research" }],
        quickPrompts: [{ zh: "帮我调研" }, { en: "Research this market" }],
      }),
    );
    writeFileSync(join(root, "agents", "crew-lead.md"), "---\nname: crew-lead\ndisplayName:\n  zh: \"闻研判\"\n---\nLead body.\n");
    writeFileSync(join(root, "agents", "fact-checker.md"), "---\nname: fact-checker\ndisplayName:\n  zh: \"卞辨真\"\nprofession:\n  zh: \"交叉核验员\"\n---\nMember body.\n");
    const res = await importExperts(root, { userDir });
    expect(res.installed).toEqual(["research-crew"]);
    const expert = readFileSync(join(userDir, "research-crew", "expert.md"), "utf-8");
    const front = expert.split("---")[1] ?? "";
    expect(front).not.toMatch(/[\u4e00-\u9fff]/);
    expect(front).toContain("name: Research crew");
    expect(front).toContain('tags: ["Research"]');
    expect(front).toContain('quickPrompts: ["Research this market"]');
    const member = readFileSync(join(userDir, "research-crew", "members", "fact-checker.md"), "utf-8");
    expect(member.split("---")[1]).not.toMatch(/[\u4e00-\u9fff]/);
    expect(member).toContain("name: Fact checker");
  });
});

