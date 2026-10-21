import { describe, expect, it } from "vitest";
import { onceMoreIfLocked } from "../src/main/agents/acp/driver";

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
