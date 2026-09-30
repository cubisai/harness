import { describe, expect, it } from "vitest";
import { checkShell, runCheck, tailOf } from "../src/main/check";
import { tempDir } from "./helpers";

describe("checkShell", () => {
  it("runs a POSIX shell with -l -c", () => {
    expect(checkShell("echo hi", { file: "/bin/zsh", args: [] })).toEqual({ file: "/bin/zsh", args: ["-l", "-c", "echo hi"] });
  });

  it("runs PowerShell with -NoProfile -Command", () => {
    const file = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    expect(checkShell("echo hi", { file, args: [] })).toEqual({ file, args: ["-NoProfile", "-Command", "echo hi"] });
  });

  it("runs cmd with /d /s /c", () => {
    const file = "C:\\Windows\\System32\\cmd.exe";
    expect(checkShell("echo hi", { file, args: [] })).toEqual({ file, args: ["/d", "/s", "/c", "echo hi"] });
  });
});

describe("tailOf", () => {
  it("keeps the last lines and drops trailing blanks", () => {
    const out = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    expect(tailOf(out, 3, 6000)).toBe("line 97\nline 98\nline 99");
    expect(tailOf("a\nb\n\n", 5, 6000)).toBe("a\nb");
  });

  it("normalizes CRLF", () => {
    expect(tailOf("a\r\nb\r\n", 5, 6000)).toBe("a\nb");
  });

  it("caps long text from the end with an ellipsis", () => {
    const tail = tailOf("x".repeat(100), 80, 40);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.length).toBe(41);
    expect(tail.endsWith("x".repeat(40))).toBe(true);
  });
});

const node = process.execPath;
// Quote the interpreter: both shells and cmd need it when the path has spaces.
const nodeCmd = (script: string) => `"${node}" -e "${script}"`;

describe("runCheck", () => {
  it("reports a non-zero exit", async () => {
    const r = await runCheck(nodeCmd("process.exit(3)"), tempDir(), { timeoutMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes and keeps stdout", async () => {
    const r = await runCheck(nodeCmd("process.stdout.write('hi')"), tempDir(), { timeoutMs: 10_000 });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.tail).toContain("hi");
  });

  it("times out a long-running command", async () => {
    const started = Date.now();
    const r = await runCheck(nodeCmd("setInterval(()=>{},1000)"), tempDir(), { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stops on abort", async () => {
    const controller = new AbortController();
    const p = runCheck(nodeCmd("setInterval(()=>{},1000)"), tempDir(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const r = await p;
    expect(r.ok).toBe(false);
  });
});
