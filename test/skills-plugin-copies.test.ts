import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillEntry } from "../src/shared/types";
import { ensureModelSkillsDir, ensurePlugin, pluginSkillFingerprint, prunePluginSkillCopies } from "../src/main/skills/plugin";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "skill-copies-")); dirs.push(root);
  const source = join(root, "reviewed"), roots = { plugin: join(root, "harness-plugin"), model: join(root, "harness-skills"), projects: join(root, "harness-skills-projects") };
  const make = (name: string, text = "Instructions."): SkillEntry => {
    const dir = join(source, name), md = `---\nname: ${name}\ndescription: Review\nuser-invocable: false\nargument-hint: [file]\n---\n${text}\n`;
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), md); writeFileSync(join(dir, "scripts", "check.js"), "version 1");
    return { name: `plugin_reviewer__${name}`, description: "Review", invocation: "model", calls: [], files: [], sha256: createHash("sha256").update(md).digest("hex"), dir, origin: "plugin", enabled: true, owner: { key: "g~reviewer", title: "Reviewer", enabled: true, revision: "one" } };
  };
  const a = make("review", 'Call the Skill tool with "detail".\nOrdinary "detail" is not a call.'), b = make("detail");
  const assertSkill = vi.fn((entry: SkillEntry) => { if (!entry.owner?.enabled) throw new Error("Owner Off"); });
  const opts = { assertSkill, pluginSkills: () => [a, b] };
  return { root, source, roots, a, b, opts, make };
}

describe("reviewed native skill copies", () => {
  it.each(["claude", "directory"])("rewrites only the %s copy's runtime names and preserves frontmatter flags", (kind) => {
    const e = setup(), target = join(e.root, "generated"), before = pluginSkillFingerprint(e.source);
    const copy = kind === "claude" ? ensurePlugin : ensureModelSkillsDir;
    copy([e.a], target, e.opts);
    const base = kind === "claude" ? join(target, "skills") : target;
    const text = readFileSync(join(base, e.a.name, "SKILL.md"), "utf8");
    expect(text).toContain(`name: ${e.a.name}`);
    expect(text).toContain("user-invocable: false"); expect(text).toContain("argument-hint: [file]");
    expect(text).toContain(`Call the Skill tool with "${kind === "claude" ? "harness-skills:" : ""}${e.b.name}"`);
    expect(text).toContain('Ordinary "detail"');
    expect(pluginSkillFingerprint(e.source)).toBe(before);
  });
  it("requires main's validator even when a generated cache already exists", () => {
    const e = setup(); ensureModelSkillsDir([e.a], e.roots.model, e.opts);
    expect(() => ensureModelSkillsDir([e.a], e.roots.model)).toThrow("reviewed owner");
    e.a.owner!.enabled = false;
    expect(() => ensureModelSkillsDir([e.a], e.roots.model, e.opts)).toThrow("active reviewed owner");
  });
  it("checks main ownership on every cache hit and includes sibling runtime-call mappings", () => {
    const e = setup(); ensurePlugin([e.a], join(e.roots.plugin, "abcdef012345"), e.opts);
    const before = e.opts.assertSkill.mock.calls.length;
    ensurePlugin([e.a], join(e.roots.plugin, "abcdef012345"), e.opts);
    expect(e.opts.assertSkill.mock.calls.length).toBeGreaterThan(before);
  });
  it("leaves no active partial copy when final owner validation fails", () => {
    const e = setup();
    e.opts.assertSkill.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("Owner changed"); });
    expect(() => ensureModelSkillsDir([e.a], e.roots.model, e.opts)).toThrow("Owner changed");
    expect(existsSync(e.roots.model)).toBe(false);
    expect(existsSync(join(e.a.dir!, "SKILL.md"))).toBe(true);
  });
  it("fingerprints scripts, added/deleted resources and binary bytes, not just SKILL.md", () => {
    const e = setup(); ensureModelSkillsDir([e.a], e.roots.model, e.opts);
    const stamp = readFileSync(join(e.roots.model, ".stamp"), "utf8");
    writeFileSync(join(e.a.dir!, "scripts", "check.js"), "version 2");
    writeFileSync(join(e.a.dir!, "asset.bin"), Buffer.from([0, 1, 255]));
    ensureModelSkillsDir([e.a], e.roots.model, e.opts);
    expect(readFileSync(join(e.roots.model, e.a.name, "scripts", "check.js"), "utf8")).toBe("version 2");
    expect(readFileSync(join(e.roots.model, ".stamp"), "utf8")).not.toBe(stamp);
    rmSync(join(e.a.dir!, "asset.bin"));
    ensureModelSkillsDir([e.a], e.roots.model, e.opts);
    expect(existsSync(join(e.roots.model, e.a.name, "asset.bin"))).toBe(false);
  });
  it.skipIf(process.platform === "win32").each(["file", "directory"])("rejects a reviewed %s symlink without editing its destination", (kind) => {
    const e = setup(), outside = join(e.root, "outside"); mkdirSync(outside);
    const path = join(outside, "keep.md"), text = 'Call the Skill tool with "review".'; writeFileSync(path, text);
    symlinkSync(kind === "file" ? path : outside, join(e.a.dir!, "link"), kind === "file" ? "file" : "dir");
    expect(() => ensurePlugin([e.a], e.roots.model, e.opts)).toThrow("symlinks");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(existsSync(e.roots.model)).toBe(false);
  });
  it.skipIf(process.platform === "win32")("does not rewrite through a standalone skill's symlink", () => {
    const e = setup(), file = join(e.root, "native.md"); writeFileSync(file, 'Call the Skill tool with "review".');
    symlinkSync(file, join(e.a.dir!, "linked.md"));
    const skill = { ...e.a, name: "review", origin: "harness" as const, owner: undefined };
    ensurePlugin([skill], e.roots.model);
    expect(readFileSync(file, "utf8")).toBe('Call the Skill tool with "review".');
  });
  it("rejects unsafe names and overlapping source/destination folders before touching either", () => {
    const e = setup(), before = pluginSkillFingerprint(e.source);
    expect(() => ensurePlugin([{ ...e.a, name: "../escape" }], e.roots.model, e.opts)).toThrow("name");
    expect(() => ensurePlugin([e.a], e.source, e.opts)).toThrow("overlaps");
    expect(() => ensureModelSkillsDir([e.a], join(e.a.dir!, "generated"), e.opts)).toThrow("overlaps");
    expect(pluginSkillFingerprint(e.source)).toBe(before);
  });
  it("prunes only stale owned copies across global/project/Claude scopes on Off and restart", () => {
    const e = setup(), native = { ...e.b, name: "native", origin: "harness" as const, owner: undefined };
    const plugin = join(e.roots.plugin, "abcdef012345"), project = join(e.roots.projects, "012345abcdef");
    ensurePlugin([e.a, native], plugin, e.opts);
    ensureModelSkillsDir([e.a, native], e.roots.model, e.opts);
    ensureModelSkillsDir([e.a, native], project, e.opts);
    prunePluginSkillCopies(e.roots, [e.a]);
    expect(existsSync(join(project, e.a.name))).toBe(true);
    const before = pluginSkillFingerprint(e.source);
    prunePluginSkillCopies(e.roots, []);
    for (const base of [join(plugin, "skills"), e.roots.model, project]) {
      expect(existsSync(join(base, e.a.name))).toBe(false);
      expect(existsSync(join(base, "native", "SKILL.md"))).toBe(true);
    }
    expect(pluginSkillFingerprint(e.source)).toBe(before);
    expect(existsSync(join(project, ".stamp"))).toBe(false);
    prunePluginSkillCopies(e.roots, []); // Idempotent after a restart.
  });
  it("invalidates old revisions on Update/On and creates no copies by pruning", () => {
    const e = setup(), project = join(e.roots.projects, "012345abcdef");
    ensureModelSkillsDir([e.a], project, e.opts);
    const current = { ...e.a, owner: { ...e.a.owner!, revision: "two" } };
    prunePluginSkillCopies(e.roots, [current]);
    expect(existsSync(join(project, e.a.name))).toBe(false);
    expect(existsSync(e.roots.model)).toBe(false);
    ensureModelSkillsDir([current], project, e.opts);
    expect(existsSync(join(project, e.a.name))).toBe(true);
  });
  it("retains unfamiliar scopes and refuses tampered owner paths without deleting user work", () => {
    const e = setup(), unfamiliar = join(e.roots.plugin, "user-folder"), scope = join(e.roots.plugin, "abcdef012345");
    mkdirSync(unfamiliar, { recursive: true }); writeFileSync(join(unfamiliar, "keep.md"), "user work");
    ensurePlugin([e.a], scope, e.opts);
    writeFileSync(join(scope, ".cubiq-skill-owners.json"), JSON.stringify({ version: 1, kind: "plugin", owners: [{ name: "../../user-folder", key: "g~reviewer", revision: "one" }] }));
    expect(() => prunePluginSkillCopies(e.roots, [])).toThrow("ownership record");
    expect(readFileSync(join(unfamiliar, "keep.md"), "utf8")).toBe("user work");
  });
  it.skipIf(process.platform === "win32")("never follows a generated destination symlink", () => {
    const e = setup(), outside = join(e.root, "native"); mkdirSync(outside); writeFileSync(join(outside, "keep.md"), "user work");
    symlinkSync(outside, e.roots.model, "dir");
    expect(() => ensureModelSkillsDir([e.a], e.roots.model, e.opts)).toThrow("plain directory");
    expect(() => prunePluginSkillCopies(e.roots, [])).toThrow("plain directory");
    expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("user work");
  });
  it.skipIf(process.platform === "win32")("rejects a linked delivery parent and copies a linked native source without editing it", () => {
    const e = setup(), outside = join(e.root, "native"); mkdirSync(outside); writeFileSync(join(outside, "keep.md"), "user work");
    symlinkSync(outside, e.roots.projects, "dir");
    expect(() => ensureModelSkillsDir([e.a], join(e.roots.projects, "012345abcdef"), e.opts)).toThrow("plain directory");
    expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("user work");
    const linked = join(e.root, "linked-source"); symlinkSync(e.b.dir!, linked, "dir");
    const native = { ...e.b, name: "detail", origin: "harness" as const, owner: undefined, dir: linked };
    const before = pluginSkillFingerprint(e.b.dir!);
    ensurePlugin([native], e.roots.model);
    expect(readFileSync(join(e.roots.model, "skills", "detail", "SKILL.md"), "utf8")).toContain("name: detail");
    expect(pluginSkillFingerprint(e.b.dir!)).toBe(before);
  });
});
