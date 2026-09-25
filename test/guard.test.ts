import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCommand, findPython } from "../src/main/guard";
import { fixturesDir } from "./helpers";

const script = join(fixturesDir, "fake-guard.py");

describe.skipIf(!findPython())("checkCommand", () => {
  it("blocks dangerous commands when guardrail script blocks", async () => {
    const v = await checkCommand(script, "Bash", "git push origin main");
    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/BLOCKED/);
  });

  it("allows ordinary commands", async () => {
    expect((await checkCommand(script, "Bash", "git status")).blocked).toBe(false);
  });

  it("allows commands safely when guard script is missing", async () => {
    expect((await checkCommand(join(fixturesDir, "nonexistent-guard.py"), "Bash", "git push")).blocked).toBe(false);
  });
});
