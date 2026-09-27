import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCommandSync, findOnPath, killTree, launchSpec, mergePath, parseUserEnvironment, spawnCommand } from "../src/main/winspawn";
import { tempDir } from "./helpers";

const win = process.platform === "win32";

/** An npm-style shim: a .cmd that forwards `%*` to a node script, like `codex.cmd`. */
function shim(dir: string, name: string, script: string): void {
  writeFileSync(join(dir, `${name}.js`), script);
  writeFileSync(join(dir, `${name}.cmd`), `@ECHO off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`);
}

describe.runIf(win)("winspawn on Windows", () => {
  const hard = [
    'model_catalog_json="C:\\Users\\A B\\AI Harness\\codex-catalogs\\cat.json"',
    'model_providers.x={ name = "X", base_url = "https://h/v1?a=1&b=2", env_key = "K" }',
    "%PATH%",
    "a^b|c<d>e(f)!g",
    "trailing\\",
    "",
    "plain",
  ];

  it("passes quotes, spaces and cmd metacharacters through a %* shim intact", () => {
    const dir = tempDir();
    shim(dir, "echoargs", "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const env = { ...process.env, PATH: `${dir};${process.env.PATH}` };
    expect(findOnPath("echoargs", env)?.toLowerCase()).toBe(join(dir, "echoargs.cmd").toLowerCase());
    expect(launchSpec("echoargs", [], env).viaCmd).toBe(true);
    const out = execCommandSync("echoargs", hard, { env, stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(out)).toEqual(hard);
  });

  it("runs an .exe on PATH directly", () => {
    const spec = launchSpec("node", ["-v"]);
    expect(spec.viaCmd).toBe(false);
    expect(spec.command.toLowerCase()).toMatch(/node\.exe$/);
  });

  it("killTree ends the agent behind a shim, not just cmd.exe", async () => {
    const dir = tempDir();
    shim(dir, "sleeper", "process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000);");
    const child = spawnCommand(join(dir, "sleeper.cmd"), [], { cwd: dir, stdio: ["pipe", "pipe", "ignore"] });
    const pid = await new Promise<number>((resolve) => child.stdout!.once("data", (d: Buffer) => resolve(Number(String(d).trim()))));
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    killTree(child);
    await exited;
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  });
});

describe.skipIf(win)("winspawn elsewhere", () => {
  it("leaves the command and arguments alone", () => {
    expect(launchSpec("codex", ['-c', 'a="b c"'])).toEqual({ command: "codex", args: ["-c", 'a="b c"'], viaCmd: false });
  });
});

describe("mergePath", () => {
  it("appends only the folders the current PATH lacks, ignoring case and trailing slashes", () => {
    expect(mergePath("C:\\Windows;C:\\Tools\\", "c:\\tools;C:\\Users\\me\\AppData\\Local\\agy\\bin;C:\\Windows")).toBe(
      "C:\\Windows;C:\\Tools\\;C:\\Users\\me\\AppData\\Local\\agy\\bin",
    );
    expect(mergePath("C:\\A", "C:\\A")).toBe("C:\\A");
    expect(mergePath("", "C:\\B;C:\\B")).toBe("C:\\B");
  });
});

describe("parseUserEnvironment", () => {
  it("reads REG_SZ values and expands REG_EXPAND_SZ references", () => {
    const out = [
      "",
      "HKEY_CURRENT_USER\\Environment",
      "    TOKEN_KEY    REG_SZ    abc 123",
      "    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp",
      "    UNKNOWN_REF    REG_EXPAND_SZ    %NOPE%\\x",
      "    Weird    REG_DWORD    0x1",
      "",
    ].join("\r\n");
    expect(parseUserEnvironment(out, { USERPROFILE: "C:\\Users\\me" })).toEqual({
      TOKEN_KEY: "abc 123",
      TEMP: "C:\\Users\\me\\AppData\\Local\\Temp",
      UNKNOWN_REF: "%NOPE%\\x",
    });
  });
});
