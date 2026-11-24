// Tests for the release helpers in scripts/release/release.mjs. These are pure: no fs,
// no git, no prompts — the CLI is exercised by the maintainer.
import { describe, expect, it } from "vitest";
import { bumpVersion, draftFromSubjects, insertRelease, parseChangelog, releaseNotes, setUnreleased } from "../scripts/release/release.mjs";

const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- New thing",
  "",
  "## [1.2.2] - 2026-01-02",
  "",
  "### Fixed",
  "",
  "- Old fix",
  "",
].join("\n");

describe("bumpVersion", () => {
  it("bumps patch, minor and major", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  it("drops a prerelease instead of skipping the patch", () => {
    expect(bumpVersion("1.2.3-beta.1", "patch")).toBe("1.2.3");
    expect(bumpVersion("1.2.3-beta.1", "minor")).toBe("1.3.0");
  });

  it("returns the current version unchanged", () => {
    expect(bumpVersion("1.2.3", "current")).toBe("1.2.3");
    expect(bumpVersion("1.2.3-beta.1", "current")).toBe("1.2.3-beta.1");
  });

  it("accepts an explicit greater version", () => {
    expect(bumpVersion("1.2.3", "2.0.0")).toBe("2.0.0");
    expect(bumpVersion("1.2.3", "1.2.4-rc.1")).toBe("1.2.4-rc.1");
    expect(bumpVersion("1.2.3-beta.1", "1.2.3")).toBe("1.2.3");
  });

  it("rejects an explicit version that is not greater", () => {
    expect(() => bumpVersion("1.2.3", "1.2.3")).toThrow();
    expect(() => bumpVersion("1.2.3", "1.2.2")).toThrow();
    expect(() => bumpVersion("1.2.3", "1.2.3-rc.1")).toThrow();
  });

  it("rejects garbage", () => {
    expect(() => bumpVersion("1.2", "patch")).toThrow();
    expect(() => bumpVersion("1.2.3", "banana")).toThrow();
    expect(() => bumpVersion("1.2.3", "v1.2.4")).toThrow();
  });
});

describe("draftFromSubjects", () => {
  it("groups subjects as Added, Changed, Fixed in commit order", () => {
    expect(draftFromSubjects(["Add export", "Fix crash", "Tweak colours"])).toBe(
      [
        "### Added",
        "",
        "- Add export",
        "",
        "### Changed",
        "",
        "- Tweak colours",
        "",
        "### Fixed",
        "",
        "- Fix crash",
      ].join("\n"),
    );
  });

  it("drops wip, fixup, squash, amend, merge and release commits", () => {
    const subjects = ["wip", "fixup! Add x", "squash! Fix y", "amend! Tidy", "Merge branch 'x'", "Release CubiQ 1.2.3", "Add real work"];
    expect(draftFromSubjects(subjects)).toBe("### Added\n\n- Add real work");
  });

  it("drops a revert together with the subject it reverts", () => {
    expect(draftFromSubjects(["Add export", 'Revert "Add export"'])).toBe("");
    expect(draftFromSubjects(['Revert "Add export"'])).toBe("");
  });

  it("dedupes case-insensitively", () => {
    expect(draftFromSubjects(["Fix crash", "fix crash", "FIX CRASH"])).toBe("### Fixed\n\n- Fix crash");
  });

  it("strips one trailing period", () => {
    expect(draftFromSubjects(["Fix crash."])).toBe("### Fixed\n\n- Fix crash");
  });

  it("caps a long subject at 160 characters", () => {
    const out = draftFromSubjects([`Fix ${"word ".repeat(60)}end`]);
    const bullet = out.split("\n").at(-1) ?? "";
    expect(bullet.startsWith("- Fix word")).toBe(true);
    expect(bullet.slice(2).length).toBeLessThanOrEqual(160);
    expect(bullet.endsWith("...")).toBe(true);
  });

  it("returns an empty string when nothing survives", () => {
    expect(draftFromSubjects([])).toBe("");
    expect(draftFromSubjects(["   ", "wip"])).toBe("");
  });
});

describe("insertRelease", () => {
  it("moves the Unreleased notes into a dated release", () => {
    const result = insertRelease(changelog, "1.3.0", "2026-11-19");
    expect(result).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [1.3.0] - 2026-11-19",
        "",
        "### Added",
        "",
        "- New thing",
        "",
        "## [1.2.2] - 2026-01-02",
        "",
        "### Fixed",
        "",
        "- Old fix",
        "",
      ].join("\n"),
    );

    const releases = parseChangelog(result);
    expect(releases[0]!.version).toBe("Unreleased");
    expect(releases[0]!.groups).toEqual([]);
    expect(releases[1]!.version).toBe("1.3.0");
    expect(releases[1]!.date).toBe("2026-11-19");
    expect(releaseNotes(result, "1.3.0")).toBe("### Added\n\n- New thing");
  });

  it("leaves the older release byte-identical", () => {
    const result = insertRelease(changelog, "1.3.0", "2026-11-19");
    expect(result.endsWith("## [1.2.2] - 2026-01-02\n\n### Fixed\n\n- Old fix\n")).toBe(true);
  });

  it("throws without an Unreleased heading", () => {
    expect(() => insertRelease("## [1.0.0] - 2026-01-01\n", "1.1.0", "2026-11-19")).toThrow();
  });
});

describe("setUnreleased", () => {
  it("replaces only the Unreleased body", () => {
    const result = setUnreleased(changelog, "### Changed\n\n- Reworded");
    expect(result).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Changed",
        "",
        "- Reworded",
        "",
        "## [1.2.2] - 2026-01-02",
        "",
        "### Fixed",
        "",
        "- Old fix",
        "",
      ].join("\n"),
    );
  });

  it("can empty the Unreleased section", () => {
    const result = setUnreleased(changelog, "");
    expect(result).toContain("## [Unreleased]\n\n## [1.2.2]");
    expect(parseChangelog(result)[0]!.groups).toEqual([]);
    expect(result.endsWith("- Old fix\n")).toBe(true);
  });

  it("throws without an Unreleased heading", () => {
    expect(() => setUnreleased("## [1.0.0] - 2026-01-01\n", "x")).toThrow();
  });
});
