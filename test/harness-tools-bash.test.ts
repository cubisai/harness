import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { bashTool, shellFor } from "../src/main/harness/tools/bash";
import { todoTool, todosOf } from "../src/main/harness/tools/todo";
import { ToolError, type ToolContext } from "../src/main/harness/tools/types";

const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "harness-"));
  dirs.push(d);
  return d;
}

function ctx(cwd = tmp(), over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    outputDir: join(cwd, ".out"),
    callId: "c1",
    reads: new Map(),
    guardScript: BUILT_IN_GUARD,
    ...over,
  };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

const posix = it.skipIf(process.platform === "win32");

describe("shellFor", () => {
  it("picks bash (or sh) on POSIX", () => {
    const shell = shellFor("darwin", {});
    const hasBash = existsSync("/bin/bash");
    expect(shell.file).toBe(hasBash ? "/bin/bash" : "/bin/sh");
    expect(shell.name).toBe(hasBash ? "bash" : "sh");
    expect(shell.args("echo hi")).toEqual(["-c", "echo hi"]);
  });

  it("uses Git Bash first on Windows when it exists", () => {
    const root = tmp();
    const bashExe = join(root, "Git", "bin", "bash.exe");
    mkdirSync(join(root, "Git", "bin"), { recursive: true });
    writeFileSync(bashExe, "");
    const shell = shellFor("win32", { ProgramFiles: root });
    expect(shell.name).toBe("Git Bash");
    expect(shell.file).toBe(bashExe);
    expect(shell.args("ls")).toEqual(["-c", "ls"]);
  });

  it("falls back to PowerShell on Windows without Git Bash", () => {
    const root = tmp();
    const env = { ProgramFiles: join(root, "a"), "ProgramFiles(x86)": join(root, "b"), LOCALAPPDATA: join(root, "c") };
    const shell = shellFor("win32", env);
    expect(shell.name).toBe("PowerShell");
    expect(shell.file).toBe("powershell.exe");
    expect(shell.args("dir")).toEqual(["-NoProfile", "-NonInteractive", "-Command", "dir"]);
  });
});

describe("bashTool summarize", () => {
  it("uses the first line, cut to 160 chars", () => {
    expect(bashTool.summarize({ command: "echo hi\necho bye" })).toBe("echo hi");
    expect(bashTool.summarize({ command: "x".repeat(200) })).toBe("x".repeat(160));
  });
});

describe("bashTool (POSIX)", () => {
  posix("answers soon after the shell exits even when a background job keeps the pipes open", async () => {
    const started = Date.now();
    const res = await bashTool.run({ command: "sleep 30 & echo started" }, ctx());
    expect(res.text).toContain("started");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  posix("runs a command and returns stdout with exit 0", async () => {
    const res = await bashTool.run({ command: "echo hello" }, ctx());
    expect(res.text).toBe("hello\n");
    expect(res.isError).toBeFalsy();
    expect((res.display?.result as { exitCode: number }).exitCode).toBe(0);
  });

  posix("shows a non-zero exit code", async () => {
    const res = await bashTool.run({ command: "exit 3" }, ctx());
    expect(res.text).toContain("Exit code 3");
    expect(res.isError).toBeFalsy();
  });

  posix("captures stderr", async () => {
    const res = await bashTool.run({ command: "echo oops >&2" }, ctx());
    expect(res.text).toContain("oops");
  });

  posix("runs in the thread's folder", async () => {
    const cwd = tmp();
    const res = await bashTool.run({ command: "pwd" }, ctx(cwd));
    const out = res.text.trim();
    expect(out === cwd || out === realpathSync(cwd)).toBe(true);
  });

  posix("kills a command that outlives its timeout", async () => {
    const start = Date.now();
    const res = await bashTool.run({ command: "sleep 5", timeout: 300 }, ctx());
    const elapsed = Date.now() - start;
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Killed after 300 ms (timeout).");
    expect((res.display?.result as { exitCode: number | null }).exitCode).toBeNull();
    expect(elapsed).toBeLessThan(3000);
  });

  posix("stops on abort", async () => {
    const ac = new AbortController();
    const p = bashTool.run({ command: "sleep 5" }, ctx(undefined, { signal: ac.signal }));
    ac.abort();
    await expect(p).rejects.toThrow("Stopped.");
  });

  posix("streams chunks through onOutput", async () => {
    const chunks: string[] = [];
    await bashTool.run({ command: "printf one; printf two" }, ctx(undefined, { onOutput: (t) => chunks.push(t) }));
    expect(chunks.join("")).toContain("one");
    expect(chunks.join("")).toContain("two");
    expect(chunks.length).toBeGreaterThan(0);
  });

  posix("refuses a command the git guardrail blocks", async () => {
    await expect(bashTool.run({ command: "git push origin main" }, ctx())).rejects.toThrow(/guardrail/);
  });

  posix("bounds long output to the tail", async () => {
    const res = await bashTool.run({ command: "seq 1 200000" }, ctx());
    expect(res.text).toContain("lines omitted");
    expect(res.text).toContain("200000");
  });
});

describe("todosOf", () => {
  it("converts a valid list to plan entries, without a priority (no agent shows one)", () => {
    expect(todosOf({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress", priority: "high" }] })).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
    ]);
  });

  it("rejects bad input", () => {
    expect(() => todosOf({})).toThrow(ToolError);
    expect(() => todosOf({ todos: "nope" })).toThrow(ToolError);
    expect(() => todosOf({ todos: [{ content: "a", status: "nope" }] })).toThrow(ToolError);
    expect(() => todosOf({ todos: [{ content: "", status: "pending" }] })).toThrow(ToolError);
    expect(() => todosOf({ todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] })).toThrow(ToolError);
  });
});

describe("todoTool", () => {
  it("returns a count summary and the active item as its display", async () => {
    const res = await todoTool.run(
      { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }] },
      ctx(),
    );
    expect(res.text).toBe("3 todos: 1 in progress, 1 completed, 1 pending. Update this list as each part finishes, and before your final reply.");
    expect(res.display?.summary).toBe("b");
    // Nothing left to update once every part is done.
    const done = await todoTool.run({ todos: [{ content: "a", status: "completed" }] }, ctx());
    expect(done.text).toBe("1 todos: 0 in progress, 1 completed, 0 pending.");
  });

  it("summarizes the raw list for the permission card", () => {
    expect(todoTool.summarize({ todos: [{ content: "b", status: "in_progress" }] })).toBe("b");
    expect(todoTool.summarize({})).toBe("0 todos");
  });
});
