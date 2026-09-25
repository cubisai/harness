import { readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { EDITORS, editorArgs, Editors, type Host, launchDetached, quoteForCmd, resolveEditor } from "../src/main/editors";
import { tempDir } from "./helpers";

const def = (id: string) => EDITORS.find((e) => e.id === id)!;

function host(platform: NodeJS.Platform, files: string[], env: NodeJS.ProcessEnv = {}, dirs: Record<string, string[]> = {}): Host {
  const set = new Set(files);
  return { platform, env, isExecutable: (p) => set.has(p), listDir: (p) => dirs[p] ?? [] };
}

describe("resolveEditor", () => {
  it("prefers PATH", () => {
    const h = host("linux", ["/opt/bin/code"], { PATH: "/usr/bin:/opt/bin" });
    expect(resolveEditor(def("vscode"), h)).toBe("/opt/bin/code");
  });

  it("finds macOS apps without PATH, which Dock-launched apps don't have", () => {
    const h = host("darwin", ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "/Users/me/Applications/Zed.app/Contents/MacOS/cli"], { HOME: "/Users/me", PATH: "/usr/bin" });
    expect(resolveEditor(def("vscode"), h)).toBe("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
    expect(resolveEditor(def("zed"), h)).toBe("/Users/me/Applications/Zed.app/Contents/MacOS/cli");
    expect(resolveEditor(def("cursor"), h)).toBeNull();
  });

  it("finds JetBrains through Toolbox, and versioned folders on Windows", () => {
    const mac = host("darwin", ["/Users/me/Library/Application Support/JetBrains/Toolbox/scripts/webstorm"], { HOME: "/Users/me" });
    expect(resolveEditor(def("webstorm"), mac)).toBe("/Users/me/Library/Application Support/JetBrains/Toolbox/scripts/webstorm");
    const pf = "C:\\Program Files";
    const w = win32.join;
    const win = host("win32", [w(pf, "JetBrains", "WebStorm 2026.2", "bin/webstorm64.exe")], { ProgramFiles: pf }, { [w(pf, "JetBrains")]: ["WebStorm 2025.3", "WebStorm 2026.2", "PyCharm 2026.1"] });
    expect(resolveEditor(def("webstorm"), win)).toBe("C:\\Program Files\\JetBrains\\WebStorm 2026.2\\bin\\webstorm64.exe");
  });

  it("finds per-user Windows installs and PATHEXT launchers", () => {
    const local = "C:\\Users\\me\\AppData\\Local";
    const cursor = "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd";
    expect(resolveEditor(def("cursor"), host("win32", [cursor], { LOCALAPPDATA: local }))).toBe(cursor);
    expect(resolveEditor(def("vscode"), host("win32", ["C:\\bin\\code.cmd"], { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" }))).toBe("C:\\bin\\code.cmd");
  });

  it("finds snap installs on Linux, and keeps Xcode to macOS", () => {
    expect(resolveEditor(def("sublime"), host("linux", ["/snap/bin/subl"], { HOME: "/home/me" }))).toBe("/snap/bin/subl");
    expect(resolveEditor(def("xcode"), host("linux", ["/usr/bin/xed"], { PATH: "/usr/bin" }))).toBeNull();
  });
});

describe("editorArgs", () => {
  it("speaks each editor family's line syntax", () => {
    expect(editorArgs("goto", "/p/a.ts", 12, 3)).toEqual(["--goto", "/p/a.ts:12:3"]);
    expect(editorArgs("suffix", "/p/a.ts", 12)).toEqual(["/p/a.ts:12"]);
    expect(editorArgs("line-column", "/p/a.ts", 12, 3)).toEqual(["--line", "12", "--column", "3", "/p/a.ts"]);
    expect(editorArgs("xed", "/p/a.ts", 12)).toEqual(["--line", "12", "/p/a.ts"]);
    expect(editorArgs("goto", "/p")).toEqual(["/p"]);
  });
});

describe("Editors.open", () => {
  const files = ["/usr/bin/code", "/usr/bin/zed"];
  it("uses the chosen editor, else the first found, with our secrets and Electron vars removed", async () => {
    const runs: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const e = new Editors(
      host("linux", files, { PATH: "/usr/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--x", GITHUB_TOKEN: "user-owned" }),
      () => ["ANTHROPIC_API_KEY"],
      async (command, args, env) => (runs.push({ command, args, env }), true),
    );
    expect(e.list()).toEqual([
      { id: "vscode", label: "VS Code" },
      { id: "zed", label: "Zed" },
    ]);
    expect(await e.open({ path: "/p/a.ts", line: 4 }, "zed")).toEqual({ ok: true, editor: "zed" });
    expect(await e.open({ path: "/p/a.ts", line: 4 }, null)).toEqual({ ok: true, editor: "vscode" });
    expect(await e.open({ path: "/p/a.ts" }, "not-installed")).toEqual({ ok: true, editor: "vscode" });
    expect(runs.map((r) => [r.command, ...r.args])).toEqual([
      ["/usr/bin/zed", "/p/a.ts:4"],
      ["/usr/bin/code", "--goto", "/p/a.ts:4"],
      ["/usr/bin/code", "/p/a.ts"],
    ]);
    expect(runs[0]!.env).toEqual({ PATH: "/usr/bin", HOME: "/h", GITHUB_TOKEN: "user-owned" });
  });

  it("says so when there's no editor, or it won't start", async () => {
    expect(await new Editors(host("linux", []), () => [], async () => true).open({ path: "/p" }, null)).toMatchObject({ ok: false, error: /No editor/ });
    expect(await new Editors(host("linux", files, { PATH: "/usr/bin" }), () => [], async () => false).open({ path: "/p" }, "zed")).toEqual({ ok: false, error: "Zed didn't start." });
  });
});

describe("quoteForCmd", () => {
  it("quotes what cmd.exe would split or expand, and refuses quotes", () => {
    expect(quoteForCmd("--goto")).toBe("--goto");
    expect(quoteForCmd("C:\\My Code\\a.ts:3")).toBe('"C:\\My Code\\a.ts:3"');
    expect(quoteForCmd("a&b")).toBe('"a&b"');
    expect(quoteForCmd("100%")).toBe('"100%%"');
    expect(() => quoteForCmd('a"b')).toThrow();
  });
});

describe("launchDetached", () => {
  it("starts a real launcher with its arguments intact", async () => {
    const dir = tempDir();
    const out = join(dir, "args.txt");
    const target = join(dir, "My Project", "a & b.ts:12");
    let launcher: string;
    if (process.platform === "win32") {
      launcher = join(dir, "fake editor.cmd");
      // %1/%2 keep their quotes, as editors' own .cmd launchers pass them on (%*).
      writeFileSync(launcher, `@echo off\r\n>"${out}" echo(%1^|%2\r\n`);
    } else {
      launcher = join(dir, "fake editor");
      writeFileSync(launcher, `#!/bin/sh\nprintf '%s|%s' "$1" "$2" > "${out}"\n`, { mode: 0o755 });
    }
    expect(await launchDetached(launcher, ["--goto", target], process.env)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(out, "utf-8").trim().replace(/"/g, "")).toBe(`--goto|${target}`);
  });

  it("reports a launcher that fails at once", async () => {
    expect(await launchDetached(join(tempDir(), "missing-editor"), [], process.env)).toBe(false);
  });
});
