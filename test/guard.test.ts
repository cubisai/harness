import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_GUARD, checkCommand, findPython, unwrapShell } from "../src/main/guard";
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

  it("falls back to the built-in rules when the guard script is missing", async () => {
    const missing = join(fixturesDir, "nonexistent-guard.py");
    expect((await checkCommand(missing, "Bash", "git push")).blocked).toBe(true);
    expect((await checkCommand(missing, "Bash", "git status")).blocked).toBe(false);
  });
});

describe("built-in rules (the git-guardrails script, ported)", () => {
  const blocked = async (command: string) => (await checkCommand(BUILT_IN_GUARD, "Bash", command)).blocked;

  it("blocks what the script blocks", async () => {
    for (const c of [
      "git push origin main",
      "git -C . push --force",
      "npm test && git push",
      "git reset --hard HEAD~1",
      "git clean -df",
      "git clean --force",
      "git branch -D feature",
      "git branch --delete --force feature",
      "git checkout .",
      "git restore .",
      "/usr/bin/git.exe push",
      "npx prisma migrate reset",
      "terraform apply -destroy",
      "psql -c 'DROP TABLE users'",
      "docker volume rm data",
      "/bin/zsh -lc 'git push --force origin main'",
    ]) {
      expect(await blocked(c), c).toBe(true);
    }
  });

  it("allows what the script allows", async () => {
    for (const c of [
      "git status",
      "git log --oneline",
      "git checkout -p .",
      "git branch -d merged",
      "git reset --soft HEAD~1",
      "echo 'git push is blocked'",
      "grep -r \"git push\" docs",
      "git commit -m 'push later'",
    ]) {
      expect(await blocked(c), c).toBe(false);
    }
  });

  it("gives the script's reason", async () => {
    const v = await checkCommand(BUILT_IN_GUARD, "Bash", "git reset --hard");
    expect(v.reason).toBe("BLOCKED: 'git reset --hard' -- git reset --hard discards uncommitted work. The user has prevented you from doing this.");
  });
});

describe("unwrapShell", () => {
  it("unwraps the shell wrappers agents send commands in", () => {
    expect(unwrapShell("/bin/zsh -lc 'git push --force origin main'")).toBe("git push --force origin main");
    expect(unwrapShell('bash -c "git reset --hard"')).toBe("git reset --hard");
    expect(unwrapShell("sh -c 'bash -lc '\\''git push'\\'''")).toBe("git push");
    expect(unwrapShell("/bin/bash -l -c 'echo hi'")).toBe("echo hi");
  });

  it("unwraps Windows shells (Codex runs commands through PowerShell there)", () => {
    expect(unwrapShell(`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'git branch -D x'`)).toBe("git branch -D x");
    expect(unwrapShell(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "git push"`)).toBe("git push");
    expect(unwrapShell(`pwsh -c 'git log --format=''%H'''`)).toBe("git log --format='%H'");
    expect(unwrapShell(`cmd.exe /d /s /c "git reset --hard"`)).toBe("git reset --hard");
    expect(unwrapShell(`C:\\Windows\\system32\\cmd.exe /c git status`)).toBe("git status");
    expect(unwrapShell("powershell.exe script.ps1")).toBe("powershell.exe script.ps1");
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

describe("built-in rules through a Windows shell wrapper", () => {
  it("blocks Codex's PowerShell form of a dangerous command", async () => {
    const wrapped = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'git branch -D harness-guard-test'`;
    expect((await checkCommand(BUILT_IN_GUARD, "Bash", wrapped)).blocked).toBe(true);
    expect((await checkCommand(BUILT_IN_GUARD, "Bash", `powershell.exe -Command 'git status'`)).blocked).toBe(false);
  });
});
