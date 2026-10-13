import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_FILE_CAP, contextFiles } from "../src/main/harness/context/files";
import { familyOf, systemPrompt, type PromptParts } from "../src/main/harness/context/system";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cq-ctx-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (name: string, text: string) => writeFileSync(join(root, name), text);

/** PromptParts with the test's temp dir and a GPT model unless overridden. */
const parts = (over: Partial<PromptParts> = {}): PromptParts => ({
  cwd: root,
  platform: "darwin",
  shell: "zsh",
  model: "gpt-5.5",
  guide: null,
  memory: null,
  ...over,
});

describe("familyOf", () => {
  it("maps wire model ids to their family", () => {
    expect(familyOf("claude-haiku-5.5")).toBe("claude");
    expect(familyOf("gpt-5.5")).toBe("gpt");
    expect(familyOf("o4-mini")).toBe("gpt");
    expect(familyOf("gpt-5-codex")).toBe("gpt");
    expect(familyOf("gemini-3-pro")).toBe("gemini");
    expect(familyOf("deepseek-v4.1-flash")).toBe("other");
  });

  it("reads provider-prefixed ids: the apply_patch family is exactly GPT's", () => {
    expect(familyOf("openai/gpt-5.5")).toBe("gpt");
    expect(familyOf("anthropic/claude-haiku-5.5")).toBe("claude");
  });
});

describe("contextFiles", () => {
  it("reads AGENTS.md then CLAUDE.md, in order", () => {
    write("AGENTS.md", "  agents body\n");
    write("CLAUDE.md", "claude body");
    expect(contextFiles(root)).toEqual([
      { name: "AGENTS.md", text: "agents body" },
      { name: "CLAUDE.md", text: "claude body" },
    ]);
  });

  it("drops a CLAUDE.md that duplicates AGENTS.md", () => {
    write("AGENTS.md", "shared instructions\n");
    write("CLAUDE.md", "shared instructions\n");
    expect(contextFiles(root)).toEqual([{ name: "AGENTS.md", text: "shared instructions" }]);
  });

  it("cuts a file longer than the cap and marks it", () => {
    write("AGENTS.md", "x".repeat(CONTEXT_FILE_CAP + 500));
    const [file] = contextFiles(root);
    expect(file!.text).toHaveLength(CONTEXT_FILE_CAP + "\n…[cut]".length);
    expect(file!.text.endsWith("\n…[cut]")).toBe(true);
  });

  it("returns nothing when the files are missing", () => {
    expect(contextFiles(root)).toEqual([]);
  });

  it("skips a directory named AGENTS.md", () => {
    mkdirSync(join(root, "AGENTS.md"));
    expect(contextFiles(root)).toEqual([]);
  });
});

describe("systemPrompt", () => {
  it("orders base+family, guide, context files, memory, env", () => {
    const files = [{ name: "AGENTS.md", text: "project rules" }];
    const out = systemPrompt(parts({ guide: "the guide", memory: "the memory", contextFiles: files }));
    expect(out).toHaveLength(5);
    expect(out[0]).toContain("You are CubiQ's coding agent");
    expect(out[0]).toContain("apply_patch");
    expect(out[1]).toBe("the guide");
    expect(out[2]).toBe("Project instructions from AGENTS.md:\n\nproject rules");
    expect(out[3]).toBe("the memory");
  });

  it("keeps the env block last", () => {
    const out = systemPrompt(parts({ guide: "g", memory: "m", date: new Date("2026-10-09") }));
    expect(out.at(-1)).toMatch(/^Environment:/);
    expect(out.at(-1)).toContain("Date: 2026-10-09 (when this session started)");
  });

  it("includes the notes for the model's family", () => {
    expect(systemPrompt(parts({ model: "claude-haiku-5.5" }))[0]).toContain("parallel read-only");
    expect(systemPrompt(parts({ model: "gpt-5.5" }))[0]).toContain("apply_patch");
    expect(systemPrompt(parts({ model: "gemini-3-pro" }))[0]).toContain("State the plan");
    expect(systemPrompt(parts({ model: "deepseek-v4.1-flash" }))[0]).toContain("valid JSON");
  });

  it("keeps the first part identical across dates", () => {
    const a = systemPrompt(parts({ date: new Date("2020-01-01") }));
    const b = systemPrompt(parts({ date: new Date("2030-12-31") }));
    expect(a[0]).toBe(b[0]);
    expect(a.at(-1)).not.toBe(b.at(-1));
  });
});
