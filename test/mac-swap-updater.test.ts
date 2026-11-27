import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MacSwapBackend, SWAP_SCRIPT, bundlePath, isAdHocSigned, notesText, type FoundUpdate, type SwapDeps } from "../src/main/mac-swap-updater";
import { Updater } from "../src/main/updater";

const zipName = `CubiQ-0.2.0-${process.arch === "arm64" ? "arm64-" : ""}mac.zip`;

function found(over: Partial<FoundUpdate["updateInfo"]> = {}): FoundUpdate {
  return {
    isUpdateAvailable: true,
    updateInfo: { version: "0.2.0", files: [{ url: zipName, sha512: "GOOD" }], releaseNotes: "<ul><li>New thing</li></ul>", ...over },
  };
}

function fakeDeps(over: Partial<SwapDeps> = {}) {
  const calls: { run: string[][]; spawned: string[][]; quits: number; downloads: string[]; files: Record<string, string> } = {
    run: [],
    spawned: [],
    quits: 0,
    downloads: [],
    files: {},
  };
  let willQuit: (() => void) | null = null;
  const plist: Record<string, string> = { CFBundleIdentifier: "dev.aiharness.app", CFBundleShortVersionString: "0.2.0" };
  const deps: SwapDeps = {
    check: async () => found(),
    fileUrl: (info, file) => `https://example.test/${info.tag ?? `cubiq-v${info.version}`}/${file}`,
    download: async (url) => void calls.downloads.push(url),
    sha512: async () => "GOOD",
    run: async (cmd, args) => {
      calls.run.push([cmd, ...args]);
      if (cmd.endsWith("plutil")) return { stdout: `${plist[args[1]!]}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    },
    spawnDetached: (cmd, args) => void calls.spawned.push([cmd, ...args]),
    writeFile: (path, text) => void (calls.files[path] = text),
    resetDir: () => {},
    exists: () => true,
    quit: () => void calls.quits++,
    onWillQuit: (l) => void (willQuit = l),
    pid: 4242,
    appPath: "/Applications/CubiQ.app",
    bundleId: "dev.aiharness.app",
    stagingDir: "/stage",
    ...over,
  };
  return { deps, calls, plist, quitApp: () => willQuit?.() };
}

describe("MacSwapBackend", () => {
  it("keeps the staged update available when the first Restart cannot write its helper", async () => {
    const { deps, calls } = fakeDeps();
    const backend = new MacSwapBackend(deps), write = deps.writeFile;
    await backend.checkForUpdates();
    deps.writeFile = () => { throw new Error("disk full"); };
    expect(() => backend.quitAndInstall()).toThrow("disk full");
    deps.writeFile = write;
    backend.quitAndInstall();
    backend.quitAndInstall();
    expect(calls.spawned).toHaveLength(1);
    expect(calls.quits).toBe(1);
  });
  it("downloads, verifies and stages the zip, then swaps and relaunches on Restart", async () => {
    const { deps, calls } = fakeDeps();
    const backend = new MacSwapBackend(deps);
    const ready: { version: string; releaseNotes?: unknown }[] = [];
    backend.on("update-downloaded", (info: { version: string }) => void ready.push(info));
    await backend.checkForUpdates();
    expect(calls.downloads).toEqual([`https://example.test/cubiq-v0.2.0/${zipName}`]);
    expect(calls.run[0]).toEqual(["/usr/bin/ditto", "-x", "-k", `/stage/${zipName}`, "/stage/unpacked"]);
    expect(calls.run.at(-1)).toEqual(["/usr/bin/codesign", "--verify", "--deep", "--strict", "/stage/unpacked/CubiQ.app"]);
    expect(ready).toEqual([{ version: "0.2.0", releaseNotes: "<ul><li>New thing</li></ul>" }]);
    backend.quitAndInstall();
    expect(calls.files["/stage/swap.sh"]).toBe(SWAP_SCRIPT);
    expect(calls.spawned).toEqual([["/bin/sh", "/stage/swap.sh", "4242", "/Applications/CubiQ.app", "/stage/unpacked/CubiQ.app", "1"]]);
    expect(calls.quits).toBe(1);
    backend.quitAndInstall(); // the helper starts once
    expect(calls.spawned).toHaveLength(1);
  });

  it("installs on quit without relaunching, and only when install-on-quit is on", async () => {
    const off = fakeDeps();
    const quiet = new MacSwapBackend(off.deps);
    quiet.autoInstallOnAppQuit = false;
    await quiet.checkForUpdates();
    off.quitApp();
    expect(off.calls.spawned).toEqual([]);

    const on = fakeDeps();
    const backend = new MacSwapBackend(on.deps);
    await backend.checkForUpdates();
    on.quitApp();
    expect(on.calls.spawned[0]!.at(-1)).toBe("0");
    expect(on.calls.quits).toBe(0); // the app is already quitting
  });

  it("refuses a download whose checksum, bundle id or version is wrong", async () => {
    for (const [name, mutate] of [
      ["sha512", (f: ReturnType<typeof fakeDeps>) => (f.deps.sha512 = async () => "BAD")],
      ["bundle id", (f: ReturnType<typeof fakeDeps>) => (f.plist.CFBundleIdentifier = "com.evil.app")],
      ["version", (f: ReturnType<typeof fakeDeps>) => (f.plist.CFBundleShortVersionString = "0.1.9")],
    ] as const) {
      const f = fakeDeps();
      mutate(f);
      const backend = new MacSwapBackend(f.deps);
      const errors: Error[] = [];
      backend.on("error", (e: Error) => void errors.push(e));
      await expect(backend.checkForUpdates(), name).rejects.toThrow();
      expect(errors, name).toHaveLength(1);
      backend.quitAndInstall();
      expect(f.calls.spawned, name).toEqual([]);
    }
  });

  it("ignores a release with no matching zip or an odd file name, and does nothing without an update", async () => {
    const none = fakeDeps({ check: async () => ({ ...found(), isUpdateAvailable: false }) });
    await new MacSwapBackend(none.deps).checkForUpdates();
    expect(none.calls.downloads).toEqual([]);

    const odd = fakeDeps({ check: async () => found({ files: [{ url: `../../${zipName}`, sha512: "GOOD" }] }) });
    await expect(new MacSwapBackend(odd.deps).checkForUpdates()).rejects.toThrow(/unexpected update file name/);

    const noZip = fakeDeps({ check: async () => found({ files: [{ url: "CubiQ-0.2.0-arm64.dmg", sha512: "GOOD" }] }) });
    await expect(new MacSwapBackend(noZip.deps).checkForUpdates()).rejects.toThrow(/no .* \.zip/);
  });

  it("works under Updater: the status carries the version and plain-text notes", async () => {
    const { deps } = fakeDeps();
    const seen: unknown[] = [];
    const u = new Updater(new MacSwapBackend(deps), "0.1.0", () => true, (s) => seen.push(s));
    await u.check();
    expect(seen).toEqual([{ current: "0.1.0", ready: "0.2.0", notes: "- New thing", supported: true }]);
  });
});

describe("helpers", () => {
  it("tells an ad-hoc signature from a Developer ID one", () => {
    expect(isAdHocSigned("Executable=/A\nSignature=adhoc\nTeamIdentifier=not set")).toBe(true);
    expect(isAdHocSigned("/A: code object is not signed at all")).toBe(true);
    expect(isAdHocSigned("Authority=Developer ID Application: X (ABCDE12345)\nTeamIdentifier=ABCDE12345")).toBe(false);
  });

  it("finds the bundle that holds the executable", () => {
    expect(bundlePath("/Applications/CubiQ.app/Contents/MacOS/CubiQ")).toBe("/Applications/CubiQ.app");
    expect(bundlePath("/usr/local/bin/electron")).toBeNull();
  });

  it("turns GitHub's HTML notes into text lines", () => {
    expect(notesText("<h3>Fixed</h3>\n<ul>\n<li>A &amp; B</li>\n<li><code>x</code> works</li>\n</ul>")).toBe("Fixed\n- A & B\n- x works");
    expect(notesText([{ version: "0.2.0", note: "<p>Hi</p>" }])).toBe("Hi");
    expect(notesText(null)).toBeNull();
    expect(notesText("")).toBeNull();
  });
});

// The real helper script against real folders: the swap, and the rollback when the move in fails.
describe.skipIf(process.platform === "win32")("SWAP_SCRIPT", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "cubiq-swap-"));
    const target = join(dir, "Apps", "CubiQ.app");
    const staged = join(dir, "stage", "CubiQ.app");
    mkdirSync(target, { recursive: true });
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(target, "v"), "old");
    writeFileSync(join(staged, "v"), "new");
    const script = join(dir, "swap.sh");
    writeFileSync(script, SWAP_SCRIPT);
    return { target, staged, script };
  };

  it("waits for the pid, then swaps the bundle in", () => {
    const { target, staged, script } = setup();
    // A pid that has already exited: the helper goes straight on.
    const gone = spawnSync("true").pid ?? 999999;
    execFileSync("/bin/sh", [script, String(gone), target, staged, "0"]);
    expect(readFileSync(join(target, "v"), "utf8")).toBe("new");
    expect(existsSync(`${target}.cubiq-old`)).toBe(false);
  });

  it("puts the old bundle back when the new one can't move in", () => {
    const { target, script } = setup();
    execFileSync("/bin/sh", [script, "999999", target, join(dir, "missing.app"), "0"], { stdio: "ignore" });
    expect(readFileSync(join(target, "v"), "utf8")).toBe("old");
  });
});
