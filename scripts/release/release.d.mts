// Types for scripts/release/release.mjs.

/** Next version for a release; `current` returns the input, explicit versions must move forward. */
export function bumpVersion(current: string, kind: string): string;

/** Markdown body (groups + bullets, no `## ` heading) drafted from commit subjects. */
export function draftFromSubjects(subjects: string[]): string;

/** Roll the Unreleased body into a new dated release directly below an empty Unreleased heading. */
export function insertRelease(changelog: string, version: string, date: string): string;

/** Replace the Unreleased body, keeping the heading and every other line as they were. */
export function setUnreleased(changelog: string, body: string): string;

export interface ChangelogGroup {
  /** "Added", "Changed", "Fixed", … */
  title: string;
  items: string[];
}

export interface ChangelogRelease {
  /** "1.2.3", or "Unreleased". */
  version: string;
  /** YYYY-MM-DD; null for Unreleased. */
  date: string | null;
  groups: ChangelogGroup[];
}

export function parseChangelog(text: string): ChangelogRelease[];
export function releaseNotes(text: string, version: string): string | null;
export function releasedEntries(text: string, limit?: number): ChangelogRelease[];
