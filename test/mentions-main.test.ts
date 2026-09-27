import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mentionNote } from "../src/main/mentions";
import { tempDir } from "./helpers";

const HEADER = "\n\nThe user mentioned these (paths relative to the project root; read them as needed):";

describe("mentionNote", () => {
  it("lists an existing file and folder, relative to the project root", () => {
    const root = tempDir();
    writeFileSync(join(root, "a.ts"), "");
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "b.ts"), "");
    expect(mentionNote(root, ["src/lib/b.ts", "src/lib/", "a.ts"])).toBe(
      `${HEADER}\n- src/lib/b.ts (file)\n- src/lib/ (folder)\n- a.ts (file)`,
    );
  });

  it("normalises backslash separators", () => {
    const root = tempDir();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "");
    expect(mentionNote(root, ["src\\a.ts"])).toBe(`${HEADER}\n- src/a.ts (file)`);
  });

  it("drops a path that no longer exists", () => {
    const root = tempDir();
    expect(mentionNote(root, ["nope.ts"])).toBe("");
  });

  it("rejects parent-directory escapes", () => {
    const root = tempDir();
    writeFileSync(join(root, "a.ts"), "");
    expect(mentionNote(root, ["../a.ts"])).toBe("");
    expect(mentionNote(root, ["src/../../a.ts"])).toBe("");
  });

  it("rejects absolute paths", () => {
    const root = tempDir();
    writeFileSync(join(root, "a.ts"), "");
    expect(mentionNote(root, [join(root, "a.ts")])).toBe("");
  });

  it("returns an empty string for no surviving mentions", () => {
    const root = tempDir();
    expect(mentionNote(root, undefined)).toBe("");
    expect(mentionNote(root, [])).toBe("");
  });

  it("keeps at most 50", () => {
    const root = tempDir();
    for (let i = 0; i < 60; i++) writeFileSync(join(root, `f${i}.ts`), "");
    const note = mentionNote(
      root,
      Array.from({ length: 60 }, (_, i) => `f${i}.ts`),
    );
    expect((note.match(/^- /gm) ?? []).length).toBe(50);
  });
});
