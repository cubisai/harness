import { describe, expect, it } from "vitest";
import { onceMoreIfLocked } from "../src/main/agents/acp/driver";
import { isShellSearch } from "../src/main/code-hint";

describe("code mode only: shell searches", () => {
  it("spots grep, rg and find, also after a cd", () => {
    for (const c of ["grep -rn foo src", "rg -l 'x|y'", "find . -name '*.ts'", "cd src && rg foo", "  fd main"]) expect(isShellSearch(c)).toBe(true);
  });
  it("leaves other commands alone", () => {
    for (const c of ["bun run test", "git status", "cat package.json", "echo grep", "ls src | grep ts", "findutils --version"]) expect(isShellSearch(c)).toBe(false);
  });
});

describe("onceMoreIfLocked", () => {
  it("retries once after a database-is-locked failure", async () => {
    let calls = 0;
    const value = await onceMoreIfLocked(async () => {
      calls += 1;
      if (calls === 1) throw new Error("SQLiteError: database is locked");
      return "ok";
    }, 1);
    expect(value).toBe("ok");
    expect(calls).toBe(2);
  });
  it("passes any other error straight through, and gives up after the one retry", async () => {
    await expect(onceMoreIfLocked(async () => Promise.reject(new Error("boom")), 1)).rejects.toThrow("boom");
    let calls = 0;
    await expect(
      onceMoreIfLocked(async () => {
        calls += 1;
        throw new Error("database is locked");
      }, 1),
    ).rejects.toThrow("locked");
    expect(calls).toBe(2);
  });
});
