import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCommand, findPython, unwrapShell } from "../src/main/guard";
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

describe("unwrapShell", () => {
  it("unwraps the shell wrappers agents send commands in", () => {
    expect(unwrapShell("/bin/zsh -lc 'git push --force origin main'")).toBe("git push --force origin main");
    expect(unwrapShell('bash -c "git reset --hard"')).toBe("git reset --hard");
    expect(unwrapShell("sh -c 'bash -lc '\\''git push'\\'''")).toBe("git push");
    expect(unwrapShell("/bin/bash -l -c 'echo hi'")).toBe("echo hi");
  });

  it("leaves anything else alone", () => {
    expect(unwrapShell("git status")).toBe("git status");
    expect(unwrapShell("zsh script.sh")).toBe("zsh script.sh");
    expect(unwrapShell("bash -c 'unterminated")).toBe("bash -c 'unterminated");
  });
});

describe.skipIf(!findPython())("checkCommand with a wrapped command", () => {
  const strict = join(fixturesDir, "strict-guard.py");

  it("blocks a dangerous command hidden in a shell wrapper (Codex's form)", async () => {
    expect((await checkCommand(strict, "Bash", "/bin/zsh -lc 'git push --force origin main'")).blocked).toBe(true);
    expect((await checkCommand(strict, "Bash", "/bin/zsh -lc 'ls -la'")).blocked).toBe(false);
  });

  // The real script, when the sibling skilled checkout is present (not in CI).
  const real = join(__dirname, "..", "..", "skilled", "plugins", "skilled", "skills", "git-guardrails", "scripts", "block-dangerous-git.py");
  it.skipIf(!existsSync(real))("blocks the wrapped form with the real git-guardrails script", async () => {
    expect((await checkCommand(real, "Bash", "/bin/zsh -lc 'git push --force origin main'")).blocked).toBe(true);
    expect((await checkCommand(real, "Bash", "/bin/zsh -lc 'git status'")).blocked).toBe(false);
  });
});
