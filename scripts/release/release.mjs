// CubiQ release helper: bump package.json, roll CHANGELOG.md's Unreleased notes
// into a dated release, commit, tag `cubiq-v<version>` and optionally push — the
// push is what triggers .github/workflows/release-cubiq.yml. The pure helpers at
// the top are unit-tested; everything touching fs/git lives in main().
//
// Run: node scripts/release/release.mjs [patch|minor|major|current|<x.y.z>]
//        [--dry-run] [--push] [--yes] [--any-branch]
//      node scripts/release/release.mjs notes <version>   (prints that version's notes; the release workflow)

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

// ---- CHANGELOG.md (Keep a Changelog): also read by the build for the app's
// "What's new" and by the release workflow for the GitHub release body. ----

const HEADING = /^## \[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

/**
 * Every release in the file, newest first as written. `Unreleased` is
 * included with a null date; bullets keep their text without the `- `.
 * @param {string} text
 * @returns {import("./release.d.mts").ChangelogRelease[]}
 */
export function parseChangelog(text) {
  const releases = [];
  let release = null;
  let group = null;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = HEADING.exec(line);
    if (heading) {
      release = { version: heading[1], date: heading[2] ?? null, groups: [] };
      releases.push(release);
      group = null;
      continue;
    }
    if (!release) continue;
    if (line.startsWith("## ")) {
      release = null; // a heading we don't understand ends the release
      continue;
    }
    const sub = /^### (.+)$/.exec(line);
    if (sub) {
      group = { title: sub[1].trim(), items: [] };
      release.groups.push(group);
      continue;
    }
    const bullet = /^[-*] (.+)$/.exec(line);
    if (bullet) {
      if (!group) {
        group = { title: "Changed", items: [] };
        release.groups.push(group);
      }
      group.items.push(bullet[1].trim());
    } else if (/^\s{2,}\S/.test(line) && group?.items.length) {
      // A wrapped bullet continues the previous item.
      group.items[group.items.length - 1] += ` ${line.trim()}`;
    }
  }
  for (const r of releases) r.groups = r.groups.filter((g) => g.items.length > 0);
  return releases;
}

/**
 * One release as Markdown (its groups and bullets, no version heading): the
 * GitHub release body. Null when the version isn't in the file or is empty.
 * @param {string} text
 * @param {string} version
 * @returns {string | null}
 */
export function releaseNotes(text, version) {
  const release = parseChangelog(text).find((r) => r.version === version);
  if (!release || release.groups.length === 0) return null;
  return release.groups.map((g) => `### ${g.title}\n\n${g.items.map((i) => `- ${i}`).join("\n")}`).join("\n\n");
}

/**
 * The released versions only (no Unreleased), at most `limit`: what a build
 * bakes into the app.
 * @param {string} text
 * @param {number} [limit]
 */
export function releasedEntries(text, limit = 10) {
  return parseChangelog(text)
    .filter((r) => r.version.toLowerCase() !== "unreleased" && r.groups.length > 0)
    .slice(0, limit);
}

// ---- Versions and drafting ----

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseVersion(value) {
  const match = SEMVER.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

// Semver ordering for prerelease identifiers: numeric < alphanumeric, and a
// shorter list is lower when every shared identifier matches.
function comparePrerelease(a, b) {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(a, b) {
  for (const part of ["major", "minor", "patch"]) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Next version for a release. `patch` on a prerelease drops the suffix
 * (1.2.3-beta.1 -> 1.2.3) instead of skipping to 1.2.4; `current` keeps the
 * version for the very first release; an explicit x.y.z must move forward.
 * @param {string} current
 * @param {string} kind
 * @returns {string}
 */
export function bumpVersion(current, kind) {
  const parsed = parseVersion(current);
  if (!parsed) throw new Error(`invalid current version "${current}"`);
  if (kind === "current") return current;
  if (kind === "patch" || kind === "minor" || kind === "major") {
    const { major, minor, patch, prerelease } = parsed;
    if (kind === "patch") return prerelease ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
    if (kind === "minor") return `${major}.${minor + 1}.0`;
    return `${major + 1}.0.0`;
  }
  const next = parseVersion(kind);
  if (!next) throw new Error(`"${kind}" is not a version (use patch, minor, major, current or x.y.z)`);
  if (compareVersions(next, parsed) <= 0) {
    throw new Error(`${kind} is not greater than the current version ${current}`);
  }
  return kind;
}

const DROP_SUBJECT = /^(wip\b|fixup!|squash!|amend!|merge\b|release cubiq\b)/i;
const REVERT_SUBJECT = /^revert\s+"(.+)"\.?$/i;

function groupOf(subject) {
  if (/^fix(e[sd])?\b/i.test(subject)) return "Fixed";
  if (/^(add(s|ed)?|new|introduce[sd]?|support)\b/i.test(subject)) return "Added";
  return "Changed";
}

// Keep one bullet under the 160-character cap, cutting on a word boundary.
function capBullet(text) {
  if (text.length <= 160) return text;
  const cut = text.slice(0, 157);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}...`;
}

/**
 * Markdown body (groups + bullets, no `## ` heading) drafted from commit
 * subjects, for a maintainer to review in the Unreleased section.
 * @param {string[]} subjects
 * @returns {string}
 */
export function draftFromSubjects(subjects) {
  const kept = [];
  for (const raw of subjects) {
    const subject = raw.trim();
    if (!subject || DROP_SUBJECT.test(subject)) continue;
    kept.push(subject);
  }

  // A revert and the commit it undoes cancel out; a lone revert is noise too.
  const reverts = new Set();
  const reverted = new Set();
  for (const subject of kept) {
    const match = REVERT_SUBJECT.exec(subject);
    if (!match) continue;
    reverts.add(subject.toLowerCase());
    reverted.add(match[1].trim().toLowerCase());
  }

  const groups = { Added: [], Changed: [], Fixed: [] };
  const seen = new Set();
  for (const subject of kept) {
    const key = subject.toLowerCase();
    if (reverts.has(key) || reverted.has(key)) continue;
    const bullet = subject.replace(/\.$/, "");
    const dedupeKey = bullet.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    groups[groupOf(bullet)].push(capBullet(bullet));
  }

  return ["Added", "Changed", "Fixed"]
    .filter((title) => groups[title].length > 0)
    .map((title) => `### ${title}\n\n${groups[title].map((item) => `- ${item}`).join("\n")}`)
    .join("\n\n");
}

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

// Split a changelog around its Unreleased section, tolerating a final newline
// and a trailing CR on each line.
function splitUnreleased(text) {
  const finalNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (finalNewline) lines.pop();

  const start = lines.findIndex((line) => line.trimEnd() === "## [Unreleased]");
  if (start === -1) throw new Error("CHANGELOG.md has no ## [Unreleased] heading");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return { finalNewline, lines, start, end };
}

/**
 * Turn the Unreleased body into a dated release, leaving Unreleased empty and
 * every other line as it was.
 * @param {string} changelog
 * @param {string} version
 * @param {string} date
 * @returns {string}
 */
export function insertRelease(changelog, version, date) {
  const { finalNewline, lines, start, end } = splitUnreleased(changelog);
  const body = trimBlankLines(lines.slice(start + 1, end));
  const after = lines.slice(end);

  const out = [...lines.slice(0, start + 1), "", `## [${version}] - ${date}`];
  if (body.length > 0) out.push("", ...body);
  if (after.length > 0) out.push("", ...after);
  return out.join("\n") + (finalNewline ? "\n" : "");
}

/**
 * Replace the Unreleased body (everything up to the next `## ` heading, or the
 * end of the file); used to drop notes drafted from commit subjects.
 * @param {string} changelog
 * @param {string} body
 * @returns {string}
 */
export function setUnreleased(changelog, body) {
  const { finalNewline, lines, start, end } = splitUnreleased(changelog);
  const bodyLines = trimBlankLines(body.replace(/\r\n/g, "\n").split("\n"));
  const after = lines.slice(end);

  const out = [...lines.slice(0, start + 1)];
  if (bodyLines.length > 0) out.push("", ...bodyLines);
  if (after.length > 0) out.push("", ...after);
  return out.join("\n") + (finalNewline ? "\n" : "");
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const line = stderr.split("\n").map((s) => s.trim()).find(Boolean);
    throw new Error(line || `git ${args.join(" ")} failed`);
  }
}

// For existence checks, where a non-zero exit just means "not there".
function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = { kind: "patch", dryRun: false, push: false, yes: false, anyBranch: false };
  let kindSeen = false;
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--push") options.push = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--any-branch") options.anyBranch = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/release/release.mjs [patch|minor|major|current|<x.y.z>] [--dry-run] [--push] [--yes] [--any-branch]\n",
      );
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else if (!kindSeen) {
      options.kind = arg;
      kindSeen = true;
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  return options;
}

async function askAndClose(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function isYes(answer) {
  return /^y(es)?$/i.test(answer.trim());
}

function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function printPush(branch, tag) {
  process.stdout.write(`Push when ready:\n  git push origin ${branch}\n  git push origin ${tag}\n`);
}

function printDryRun(version, tag, notes, branch, push) {
  process.stdout.write("Dry run: no files will be written.\n\n");
  process.stdout.write(`Version: ${version}\nTag: ${tag}\n\n`);
  process.stdout.write(`Notes:\n\n${notes}\n\n`);
  process.stdout.write("Commands:\n");
  process.stdout.write("  git add package.json CHANGELOG.md\n");
  process.stdout.write(`  git commit -m "Release CubiQ ${version}"\n`);
  process.stdout.write(`  git tag -a ${tag} -m "CubiQ ${version}"\n`);
  if (push) {
    process.stdout.write(`  git push origin ${branch}\n`);
    process.stdout.write(`  git push origin ${tag}\n`);
  }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  if (process.argv[2] === "notes") {
    const version = process.argv[3];
    const notes = version ? releaseNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version) : null;
    if (!notes) throw new Error(`CHANGELOG.md has no notes for ${version ?? "(no version given)"}`);
    process.stdout.write(`${notes}\n`);
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const packagePath = join(root, "package.json");
  const changelogPath = join(root, "CHANGELOG.md");

  if (git(["status", "--porcelain"])) {
    // A preview can run mid-change; a real release must not sweep stray edits in.
    if (!options.dryRun) throw new Error("working tree is not clean; commit or stash your changes first");
    process.stderr.write("warning: working tree is not clean (fine for a dry run)\n");
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main" && !options.anyBranch) {
    throw new Error(`on branch "${branch}"; switch to main or pass --any-branch`);
  }

  const packageText = readFileSync(packagePath, "utf8");
  const current = /"version": "([^"]+)"/.exec(packageText)?.[1];
  if (!current) throw new Error("package.json has no version field");
  const next = bumpVersion(current, options.kind);
  const tag = `cubiq-v${next}`;

  if (gitOrNull(["rev-parse", "-q", "--verify", `refs/tags/${tag}`])) {
    throw new Error(`tag ${tag} already exists locally`);
  }
  let remoteTag = "";
  try {
    remoteTag = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  } catch {
    process.stderr.write("warning: could not reach origin; skipping the remote tag check\n");
  }
  if (remoteTag) throw new Error(`tag ${tag} already exists on origin`);

  const original = readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n");
  let changelog = original;
  let drafted = false;

  const unreleased = parseChangelog(original).find((release) => release.version === "Unreleased");
  if (!unreleased || unreleased.groups.length === 0) {
    const previous = gitOrNull(["describe", "--tags", "--abbrev=0", "--match", "cubiq-v*"]);
    if (!previous) {
      throw new Error(
        "write the notes under ## [Unreleased] in CHANGELOG.md (no earlier cubiq-v tag to draft from)",
      );
    }
    const subjects = git(["log", `${previous}..HEAD`, "--no-merges", "--format=%s"]).split("\n");
    changelog = setUnreleased(changelog, draftFromSubjects(subjects));
    drafted = true;
  }

  // Dry runs never prompt or touch the tree; a real release asks before writing.
  const interactive = !options.yes && !options.dryRun && Boolean(process.stdin.isTTY);
  let draftOnDisk = false;

  try {
    if (interactive) {
      if (drafted) {
        writeFileSync(changelogPath, changelog);
        draftOnDisk = true;
        const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
        const opened = spawnSync(`${editor} "CHANGELOG.md"`, { cwd: root, shell: true, stdio: "inherit" });
        if (opened.error) throw new Error(`could not open ${editor}: ${opened.error.message}`);
        if (opened.status !== 0) throw new Error(`${editor} exited with code ${opened.status ?? "unknown"}`);
        changelog = readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n");
      }

      const preview = releaseNotes(changelog, "Unreleased");
      if (!preview) throw new Error("write the notes under ## [Unreleased] in CHANGELOG.md");
      process.stdout.write(`Notes for ${next}:\n\n${preview}\n\n`);

      if (!isYes(await askAndClose(`Release CubiQ ${next}? [y/N] `))) {
        if (draftOnDisk) writeFileSync(changelogPath, original);
        draftOnDisk = false;
        process.stdout.write("Aborted; nothing was released.\n");
        return;
      }
    }

    const notes = releaseNotes(changelog, "Unreleased");
    if (!notes) throw new Error("write the notes under ## [Unreleased] in CHANGELOG.md");

    if (options.dryRun) {
      if (draftOnDisk) {
        writeFileSync(changelogPath, original);
        draftOnDisk = false;
      }
      printDryRun(next, tag, notes, branch, options.push);
      return;
    }

    const needle = `"version": "${current}"`;
    if (!packageText.includes(needle)) throw new Error(`package.json has no ${needle} field`);
    const bumpedPackage = packageText.replace(needle, `"version": "${next}"`);

    writeFileSync(changelogPath, insertRelease(changelog, next, today()));
    draftOnDisk = false; // this is the release content, not a scratch draft
    writeFileSync(packagePath, bumpedPackage);

    git(["add", "package.json", "CHANGELOG.md"]);
    git(["commit", "-m", `Release CubiQ ${next}`]);
    git(["tag", "-a", tag, "-m", `CubiQ ${next}`]);

    if (options.push) {
      let go = options.yes;
      if (!go && process.stdin.isTTY) {
        go = isYes(
          await askAndClose(
            `Push ${branch} and ${tag} to origin? This starts the public release build. [y/N] `,
          ),
        );
      }
      if (go) {
        git(["push", "origin", branch]);
        git(["push", "origin", tag]);
        process.stdout.write(`Released CubiQ ${next}; pushed ${tag}.\n`);
      } else {
        process.stdout.write(`Committed and tagged CubiQ ${next}; not pushed.\n`);
        printPush(branch, tag);
      }
    } else {
      process.stdout.write(`Committed and tagged CubiQ ${next}.\n`);
      printPush(branch, tag);
    }
  } catch (error) {
    if (draftOnDisk) writeFileSync(changelogPath, original);
    throw error;
  }
}

// Only run the CLI when executed directly, never when a test imports helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`release: ${reason.split("\n")[0]}`);
    process.exit(1);
  });
}
