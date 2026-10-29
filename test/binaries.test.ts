import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { binaryInfo, compareVersions, newestInstallAsync, parseVersion, resolvedCommandAsync, warmBinaries } from "../src/main/agents/binaries";

// The default probes shell out (`which -a`, `<path> --version`); the mock
// answers them from tables so binaryInfo/warmBinaries can be exercised without
// spawning anything. The injected run/list below bypass it entirely.
const cp = vi.hoisted(() => ({
  paths: new Map<string, string[]>(),
  versions: new Map<string, string>(),
}));

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (err: unknown, out?: { stdout: string; stderr: string }) => void,
  ) => {
    if (file === "which" || file === "where") {
      const lines = cp.paths.get(args[args.length - 1]!) ?? [];
      if (!lines.length) callback(Object.assign(new Error("not found"), { code: 1 }));
      else callback(null, { stdout: `${lines.join("\n")}\n`, stderr: "" });
      return;
    }
    const output = cp.versions.get(file);
    if (output === undefined) callback(Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" }));
    else callback(null, { stdout: output, stderr: "" });
  },
}));

describe("parseVersion", () => {
  it("reads a plain version line", () => {
    expect(parseVersion("2.1.284 (Claude Code)")).toBe("2.1.284");
    expect(parseVersion("codex-cli 0.157.0")).toBe("0.157.0");
  });

  it("strips a leading v", () => {
    expect(parseVersion("v1.2.12")).toBe("1.2.12");
  });

  it("skips a timestamped warning and reads the version after it", () => {
    expect(parseVersion("2026/09/29 10:50:50 WARN Ripgrep (rg) not found\n0.0.55")).toBe("0.0.55");
  });

  it("skips a version-looking token on a log line", () => {
    expect(parseVersion("2026-09-29 INFO opencode 9.9.9 is available\n1.2.3")).toBe("1.2.3");
  });

  it("returns null when no line carries a version", () => {
    expect(parseVersion("garbage")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("compares major before minor before patch", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.2", "1.2.10")).toBeLessThan(0);
  });
});

describe("newestInstallAsync", () => {
  const source = (versions: Record<string, string | null>) => (path: string) => versions[path] ?? null;

  it("picks the highest version, not the first on PATH, and sorts the rest newest first", async () => {
    const paths = ["/usr/local/bin/opencode", "/opt/homebrew/bin/opencode", "/home/u/.local/bin/opencode"];
    const run = source({
      "/usr/local/bin/opencode": "1.0.126",
      "/opt/homebrew/bin/opencode": "0.0.55",
      "/home/u/.local/bin/opencode": "1.18.33",
    });
    expect(await newestInstallAsync("opencode", { preferred: [], list: () => paths, run })).toEqual({
      path: "/home/u/.local/bin/opencode",
      version: "1.18.33",
      others: [
        { path: "/usr/local/bin/opencode", version: "1.0.126" },
        { path: "/opt/homebrew/bin/opencode", version: "0.0.55" },
      ],
    });
  });

  it("prefers the preferred path on a tie", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unskilled-binaries-"));
    const preferredPath = join(dir, "preferred-claude");
    const pathPath = join(dir, "path-claude");
    writeFileSync(preferredPath, "");
    writeFileSync(pathPath, "");
    const res = await newestInstallAsync("claude", { preferred: [preferredPath], list: () => [pathPath], run: () => "2.1.284" });
    expect(res?.path).toBe(preferredPath);
    expect(res?.others).toEqual([{ path: pathPath, version: "2.1.284" }]);
  });

  it("checks a preferred path that isn't on PATH, and ignores a missing one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unskilled-binaries-"));
    const native = join(dir, "claude");
    writeFileSync(native, "");
    const run = source({ [native]: "2.1.284", "/usr/bin/claude": "2.1.222" });
    expect(await newestInstallAsync("claude", { preferred: [native, join(dir, "missing")], list: () => ["/usr/bin/claude"], run })).toEqual({
      path: native,
      version: "2.1.284",
      others: [{ path: "/usr/bin/claude", version: "2.1.222" }],
    });
  });

  it("keeps the baseline when the copies after it can't be read", async () => {
    const run = source({ "/a/opencode": null, "/b/opencode": "garbage", "/c/opencode": "2.0.0" });
    expect(await newestInstallAsync("opencode", { preferred: [], list: () => ["/a/opencode", "/b/opencode", "/c/opencode"], run })).toEqual({
      path: "/a/opencode",
      version: "unknown",
      others: [
        { path: "/c/opencode", version: "2.0.0" },
        { path: "/b/opencode", version: "unknown" },
      ],
    });
  });

  it("dedupes by real path, keeping the first path found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unskilled-binaries-"));
    const real = join(dir, "opencode");
    writeFileSync(real, "");
    const res = await newestInstallAsync("opencode", { preferred: [real], list: () => [real], run: () => "1.18.33" });
    expect(res).toEqual({ path: real, version: "1.18.33", others: [] });
  });

  it("returns null only when there are no candidates at all", async () => {
    expect(await newestInstallAsync("opencode", { preferred: [], list: () => [], run: () => null })).toBeNull();
    // A candidate that exists is kept even when its probe yields no version.
    expect(await newestInstallAsync("opencode", { preferred: [], list: () => ["/a/opencode"], run: () => "garbage" })).toEqual({
      path: "/a/opencode",
      version: "unknown",
      others: [],
    });
  });

  it("accepts async run and list injections", async () => {
    const run = async (path: string) => (path === "/d/opencode" ? "1.2.3" : null);
    const list = async () => ["/d/opencode"];
    expect(await newestInstallAsync("opencode", { preferred: [], list, run })).toEqual({ path: "/d/opencode", version: "1.2.3", others: [] });
  });

  // (a) The regression: the newest copies' probes fail while the oldest answers.
  // The first PATH entry (what a shell would run) must win, never the 0.0.55.
  it("never downgrades to a lower copy when the baseline's probe fails", async () => {
    const paths = ["/home/u/.local/share/fnm/aliases/default/bin/opencode", "/usr/local/bin/opencode", "/opt/homebrew/bin/opencode"];
    const run = (path: string): string | null => {
      if (path === "/opt/homebrew/bin/opencode") return "0.0.55";
      throw new Error(`probe failed: ${path}`);
    };
    const res = await newestInstallAsync("opencode", { preferred: [], list: () => paths, run });
    expect(res?.path).toBe(paths[0]);
    expect(res?.version).toBe("unknown");
    expect(res?.path).not.toBe("/opt/homebrew/bin/opencode");
  });

  // (b) A strictly newer copy that answers replaces the baseline.
  it("upgrades to a strictly newer candidate that answers", async () => {
    const paths = ["/a/opencode", "/b/opencode"];
    const run = source({ "/a/opencode": "1.0.126", "/b/opencode": "1.18.33" });
    expect(await newestInstallAsync("opencode", { preferred: [], list: () => paths, run })).toEqual({
      path: "/b/opencode",
      version: "1.18.33",
      others: [{ path: "/a/opencode", version: "1.0.126" }],
    });
  });

  // (c) An older copy never displaces the baseline.
  it("keeps the baseline when the other candidate is older", async () => {
    const paths = ["/a/opencode", "/b/opencode"];
    const run = source({ "/a/opencode": "1.18.33", "/b/opencode": "0.0.55" });
    expect(await newestInstallAsync("opencode", { preferred: [], list: () => paths, run })).toEqual({
      path: "/a/opencode",
      version: "1.18.33",
      others: [{ path: "/b/opencode", version: "0.0.55" }],
    });
  });

  // (d) Probes for one command run one at a time.
  it("probes candidates sequentially", async () => {
    const paths = ["/a/opencode", "/b/opencode", "/c/opencode"];
    const versions: Record<string, string> = { "/a/opencode": "1.0.0", "/b/opencode": "1.1.0", "/c/opencode": "1.2.0" };
    let inflight = 0;
    let maxInflight = 0;
    const run = async (path: string): Promise<string | null> => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inflight -= 1;
      return versions[path] ?? null;
    };
    const res = await newestInstallAsync("opencode", { preferred: [], list: () => paths, run });
    expect(maxInflight).toBe(1);
    expect(res?.path).toBe("/c/opencode");
  });
});

describe("binaryInfo / warmBinaries / resolvedCommandAsync", () => {
  it("returns undefined before the first resolution, then the warmed resolution", async () => {
    cp.paths.set("warmbin-test", ["/opt/warm/bin/warmbin-test"]);
    cp.versions.set("/opt/warm/bin/warmbin-test", "3.2.1\n");
    expect(binaryInfo("warmbin-test")).toBeUndefined();
    await warmBinaries(["warmbin-test"]);
    expect(binaryInfo("warmbin-test")).toEqual({ path: "/opt/warm/bin/warmbin-test", version: "3.2.1", others: [] });
  });

  it("resolvedCommandAsync falls back to the bare command when nothing answers", async () => {
    cp.paths.set("missingbin-test", []);
    await expect(resolvedCommandAsync("missingbin-test")).resolves.toBe("missingbin-test");
    expect(binaryInfo("missingbin-test")).toBeNull();
  });

  it("resolvedCommandAsync returns the newest install's path", async () => {
    cp.paths.set("pathbin-test", ["/usr/bin/pathbin-test", "/opt/bin/pathbin-test"]);
    cp.versions.set("/usr/bin/pathbin-test", "1.0.0");
    cp.versions.set("/opt/bin/pathbin-test", "2.0.0");
    await expect(resolvedCommandAsync("pathbin-test")).resolves.toBe("/opt/bin/pathbin-test");
  });
});
