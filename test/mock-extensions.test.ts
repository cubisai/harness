import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills, parseSkillMd } from "../src/main/skills/discover";
import { testServer } from "../src/main/mcp/servers";
import { generate, makeTools, PRESETS } from "../scripts/mock-extensions-lib.mjs";
import { tempDir } from "./helpers";

const CLI = join(__dirname, "..", "scripts", "mock-extensions.mjs");
const SERVER = join(__dirname, "fixtures", "mock-mcp-many.mjs");

function writeFiles(root: string, files: { path: string; content: string }[]): void {
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

describe("mock extension kit", () => {
  it("generates byte-identical files for the same inputs, and differs across seeds", () => {
    const args = { skills: 12, servers: 3, tools: 6, seed: 7, serverScript: SERVER };
    expect(generate(args).files).toEqual(generate(args).files);
    expect(generate({ ...args, seed: 8 }).files).not.toEqual(generate(args).files);
  });

  it("matches each preset's counts, with unique names", () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const { files, manifest } = generate({ ...preset, seed: 1, serverScript: SERVER });
      expect(files.filter((f) => f.path.endsWith("/SKILL.md")), name).toHaveLength(preset.skills);
      expect(Object.keys(JSON.parse(files.find((f) => f.path === ".mcp.json")!.content).mcpServers), name).toHaveLength(preset.servers);
      expect(manifest.tools, name).toHaveLength(preset.servers * preset.tools);
      expect(new Set(manifest.skills.map((s) => s.name)).size, name).toBe(preset.skills);
      const byServer = new Map<string, string[]>();
      for (const tool of manifest.tools) byServer.set(tool.server, [...(byServer.get(tool.server) ?? []), tool.name]);
      for (const names of byServer.values()) expect(new Set(names).size, name).toBe(names.length);
    }
  });

  it("discovers the generated skills with their sentinels", () => {
    const root = tempDir();
    const { files, manifest } = generate({ ...PRESETS.small, seed: 2, serverScript: SERVER });
    writeFiles(root, files);
    const dir = join(root, ".agents", "skills");
    const found = discoverSkills({ origin: "project", dir });
    expect(found).toHaveLength(PRESETS.small.skills);
    for (const skill of found) expect(skill.description.length).toBeGreaterThan(0);
    for (const skill of manifest.skills) {
      const parsed = parseSkillMd(readFileSync(join(dir, skill.name, "SKILL.md"), "utf-8"));
      expect((parsed.description ?? "").length).toBeLessThanOrEqual(1024);
      expect(parsed.body).toContain(skill.sentinel);
    }
  });

  it("makes 10 mixed evals pointing at real sentinels", () => {
    const { manifest } = generate({ ...PRESETS.medium, seed: 5, serverScript: SERVER });
    expect(manifest.evals).toHaveLength(10);
    const kinds: Record<string, number> = {};
    for (const e of manifest.evals) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    expect(kinds).toEqual({ skill: 3, tool: 3, none: 2, ambiguous: 2 });
    const sentinels = new Set([...manifest.skills.map((s) => s.sentinel), ...manifest.tools.map((t) => t.sentinel)]);
    for (const e of manifest.evals) for (const s of e.expect) expect(sentinels.has(s)).toBe(true);
    for (const e of manifest.evals) if (e.kind === "skill") expect(e.prompt).not.toContain(e.expect[0]!.replace("SENTINEL-skill-", ""));
  });

  it("serves the generated tools over real stdio", async () => {
    const res = await testServer({ type: "stdio", command: process.execPath, args: [SERVER, "--name", "mock-database", "--tools", "12", "--seed", "3"] });
    expect(res.ok).toBe(true);
    expect(res.tools.map((t) => t.name)).toEqual(makeTools("mock-database", 12, 3).map((t) => t.name));
  });

  it("writes via the CLI, refusing to overwrite without --force", () => {
    const root = tempDir();
    const out = join(root, "out");
    const first = spawnSync(process.execPath, [CLI, "--out", out, "--preset", "small"], { encoding: "utf-8" });
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toMatch(/^wrote \d+ skills, \d+ servers x \d+ tools to .+ \(manifest: .+\)$/);
    expect(existsSync(join(out, ".agents", "skills"))).toBe(true);
    expect(spawnSync(process.execPath, [CLI, "--out", out, "--preset", "small"], { encoding: "utf-8" }).status).toBe(1);
    expect(spawnSync(process.execPath, [CLI, "--out", out, "--preset", "small", "--force"], { encoding: "utf-8" }).status).toBe(0);
  });

  it("parses generated SKILL.md with CRLF line endings", () => {
    const { files, manifest } = generate({ ...PRESETS.small, seed: 4, serverScript: SERVER });
    for (const skill of manifest.skills) {
      const file = files.find((f) => f.path === `.agents/skills/${skill.name}/SKILL.md`)!;
      const parsed = parseSkillMd(file.content.replace(/\n/g, "\r\n"));
      expect(parsed.name).toBe(skill.name);
      expect(parsed.description).toBe(skill.description);
      expect(parsed.body).toContain(skill.sentinel);
    }
  });

  it("--mcp-out writes the MCP JSON to the given file", () => {
    const root = tempDir();
    const out = join(root, "out");
    const other = tempDir();
    const mcpOut = join(other, "nested", "mcp.json");
    const res = spawnSync(process.execPath, [CLI, "--out", out, "--preset", "small", "--mcp-out", mcpOut], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(existsSync(mcpOut)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(mcpOut, "utf-8")).mcpServers)).toHaveLength(PRESETS.small.servers);
    expect(existsSync(join(out, ".mcp.json"))).toBe(false);
  });

  it("refuses to overwrite an existing MCP file without --force", () => {
    const root = tempDir();
    const out = join(root, "out");
    const mcp = join(out, ".mcp.json");
    mkdirSync(dirname(mcp), { recursive: true });
    writeFileSync(mcp, "keep me");
    const refused = spawnSync(process.execPath, [CLI, "--out", out, "--preset", "small"], { encoding: "utf-8" });
    expect(refused.status).toBe(1);
    expect(readFileSync(mcp, "utf-8")).toBe("keep me");
    const forced = spawnSync(process.execPath, [CLI, "--out", out, "--preset", "small", "--force"], { encoding: "utf-8" });
    expect(forced.status).toBe(0);
  });

  it("writes the manifest outside the output dir by default", () => {
    const root = tempDir();
    const out = join(root, "out");
    const res = spawnSync(process.execPath, [CLI, "--out", out, "--preset", "small"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(existsSync(join(out, "mock-manifest.json"))).toBe(false);
    const manifestPath = `${out}.manifest.json`;
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.evals).toHaveLength(10);
    expect(manifest.evals).toEqual(generate({ ...PRESETS.small, seed: 1, serverScript: SERVER }).manifest.evals);
  });

  it("--manifest-out writes the manifest to the given file", () => {
    const root = tempDir();
    const out = join(root, "out");
    const other = tempDir();
    const manifestOut = join(other, "nested", "manifest.json");
    const res = spawnSync(process.execPath, [CLI, "--out", out, "--preset", "small", "--manifest-out", manifestOut], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(existsSync(manifestOut)).toBe(true);
    expect(existsSync(join(out, "mock-manifest.json"))).toBe(false);
    expect(JSON.parse(readFileSync(manifestOut, "utf-8")).evals).toHaveLength(10);
  });

  it("refuses to overwrite an existing manifest without --force", () => {
    const root = tempDir();
    const out = join(root, "out");
    const manifestPath = `${out}.manifest.json`;
    writeFileSync(manifestPath, "keep me");
    const refused = spawnSync(process.execPath, [CLI, "--out", out, "--preset", "small"], { encoding: "utf-8" });
    expect(refused.status).toBe(1);
    expect(readFileSync(manifestPath, "utf-8")).toBe("keep me");
    const forced = spawnSync(process.execPath, [CLI, "--out", out, "--preset", "small", "--force"], { encoding: "utf-8" });
    expect(forced.status).toBe(0);
  });
});
