// T9.11: Antigravity/Gemini never run in CI, enforced by configuration.
import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../vitest.config";

const root = join(__dirname, "..");
const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8").replace(/\r\n/g, "\n");
const code = workflow
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");
// The last two only switch electron-builder's signing (ad-hoc on macOS), with no certificate.
const ALLOWED = ["UNSKILLED_NO_UPDATE", "UNSKILLED_CODEX_BIN", "CSC_IDENTITY_AUTO_DISCOVERY", "CSC_FOR_PULL_REQUEST"];

describe("CI workflow", () => {
  it("uses no secrets, and nothing Gemini or Antigravity", () => {
    expect(code).not.toMatch(/secrets\./);
    expect(code).not.toMatch(/gemini|antigravity|agy-acp|GOOGLE_API_KEY/i);
  });

  it("sets only allowlisted variables", () => {
    const declared = [...code.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
    const exported = [...code.matchAll(/echo "([A-Z][A-Z0-9_]*)=/g)].map((m) => m[1]);
    for (const name of [...declared, ...exported]) expect(ALLOWED, name).toContain(name);
    expect(exported).toEqual(["UNSKILLED_CODEX_BIN"]);
  });

  it("builds the PR installers without publishing them", () => {
    expect(workflow).toMatch(/\n {2}package:\n[\s\S]*electron-builder \$\{\{ matrix\.target \}\} --publish never/);
  });

  it("runs the packaged smoke after the test matrix", () => {
    expect(workflow).toMatch(/\n {2}smoke:\n[\s\S]*needs: test[\s\S]*node scripts\/smoke\.mjs/);
  });
});

describe("release workflow", () => {
  const release = readFileSync(join(root, ".github", "workflows", "release-cubiq.yml"), "utf-8").replace(/\r\n/g, "\n");

  it("reads only the signing secrets docs/releasing.md lists", () => {
    const secrets = new Set([...release.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    expect([...secrets].sort()).toEqual(["APPLE_APP_SPECIFIC_PASSWORD", "APPLE_ID", "APPLE_TEAM_ID", "MAC_CSC_KEY_PASSWORD", "MAC_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "WIN_CSC_LINK"]);
    const readme = readFileSync(join(root, "docs", "releasing.md"), "utf-8");
    for (const name of secrets) expect(readme, name).toContain(`\`${name}\``);
  });

  it("builds without publishing, and only the publish job writes the release", () => {
    expect(release).toContain("--publish never");
    expect(release.match(/contents: write/g)).toHaveLength(1);
    expect(release).toMatch(/\n {2}publish:\n[\s\S]*contents: write[\s\S]*gh release create/);
  });
});

describe("default test glob", () => {
  const include = config.test?.include ?? [];

  it("collects only test/ and never manual/", () => {
    expect(include.length).toBeGreaterThan(0);
    for (const pattern of include) {
      expect(pattern.startsWith("test/"), pattern).toBe(true);
      expect(matchesGlob("manual/antigravity.test.ts", pattern), pattern).toBe(false);
    }
    expect(config.test?.exclude).toContain("manual/**");
  });
});
