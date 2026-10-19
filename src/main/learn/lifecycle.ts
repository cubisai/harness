// S4, the lesson lifecycle: pure rules for what a session is sent, how real
// turns score it, and when it retires, is actioned, re-verified or promoted.

import type { Health, Lesson, LessonAction, LessonVerification } from "../../shared/learn";

/** How many active lessons one session is sent at most. */
export const MAX_INJECTED = 5;

/** The active lessons a session gets: pinned first, then helpful − harmful, then newest. */
export function relevantLessons(lessons: Lesson[], max = MAX_INJECTED): Lesson[] {
  return lessons
    .filter((l) => l.status === "active")
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.helpful - b.harmful - (a.helpful - a.harmful) || b.updatedAt - a.updatedAt)
    .slice(0, max);
}

/** The longest one bullet may be. */
const MAX_LINE = 300;

/** One text as a single line: newlines (and their indent) become spaces. */
function oneline(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** One lesson as a bullet, clipped, with "(why)" only when there is a why. */
function lessonLine(l: Lesson): string {
  const why = oneline(l.why);
  const line = why ? `- ${oneline(l.rule)} (${why})` : `- ${oneline(l.rule)}`;
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/** The block appended to an agent's memory prompt; null when there are none. */
export function lessonsBlock(lessons: Lesson[]): string | null {
  if (!lessons.length) return null;
  return [
    "<harness-lessons>",
    "Rules learned from earlier turns in this project. Follow them unless the user says otherwise.",
    ...lessons.map(lessonLine),
    "</harness-lessons>",
  ].join("\n");
}

/** A real turn the lessons were sent with ended `health`: relevant+1; ok → helpful+1; fail → harmful+1; warn → neither. */
export function countOutcome(l: Lesson, health: Health): Pick<Lesson, "relevant" | "helpful" | "harmful"> {
  return { relevant: l.relevant + 1, helpful: l.helpful + (health === "ok" ? 1 : 0), harmful: l.harmful + (health === "fail" ? 1 : 0) };
}

/** An active lesson that keeps hurting retires itself: harmful ≥ 3 and harmful > 2 × helpful. */
export function autoRetire(l: Pick<Lesson, "status" | "helpful" | "harmful" | "relevant">): { status: "retired"; note: string } | null {
  if (l.status !== "active" || l.harmful < 3 || l.harmful <= 2 * l.helpful) return null;
  return { status: "retired", note: `retired: hurt ${l.harmful} of ${l.relevant} turns` };
}

/** The patch a user action makes, or null when it doesn't apply to the lesson's status. */
export function applyAction(l: Lesson, action: LessonAction): Partial<Pick<Lesson, "status" | "pinned" | "note">> | null {
  switch (action) {
    case "retire":
      return l.status === "active" || l.status === "candidate" ? { status: "retired", note: "retired by you" } : null;
    case "undo":
      return l.status === "retired" || l.status === "dropped" ? { status: l.verified ? "active" : "candidate", note: null } : null;
    case "pin":
      return l.status === "dropped" ? null : { pinned: true };
    case "unpin":
      return { pinned: false };
    case "drop":
      return l.status === "candidate" ? { status: "dropped", note: "dropped by you" } : null;
  }
}

export interface Runtime {
  model: string;
  agent: string;
  appVersion: string;
}

/** The first two dot-separated version numbers; patch changes don't count. */
function majorMinor(v: string): string {
  const [major = "0", minor = "0"] = v.split(".");
  return `${major}.${minor}`;
}

/** Why an active lesson must be re-verified under `rt`, or null when its evidence still holds. */
export function revalidation(l: Lesson, rt: Runtime): string | null {
  if (l.status !== "active") return null;
  const v = l.verified;
  if (!v) return "never verified";
  if (v.model !== rt.model) return `verified on ${v.model}, now ${rt.model}`;
  if (v.agent !== rt.agent) return `verified on ${v.agent}, now ${rt.agent}`;
  if (majorMinor(v.appVersion) !== majorMinor(rt.appVersion)) return `verified on app ${v.appVersion}, now ${rt.appVersion}`;
  return null;
}

/** Promote only with both replay and transfer evidence. */
export function promotion(v: LessonVerification): { promote: boolean; why: string } {
  if (!(v.before.of >= 1 && v.before.passed < v.before.of)) return { promote: false, why: "its case already passes without it" };
  if (!(v.after.of >= 1 && v.after.passed === v.after.of && v.after.passed > v.before.passed)) return { promote: false, why: "its case still fails with it" };
  if (v.transfer.of < 1) return { promote: false, why: "no other case to check transfer on" };
  if (v.transfer.held !== v.transfer.of) return { promote: false, why: `changed the result of ${v.transfer.of - v.transfer.held} of ${v.transfer.of} other cases` };
  return { promote: true, why: `fixed its case and held on ${v.transfer.of} other case(s)` };
}
