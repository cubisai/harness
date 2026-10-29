import type { Question, QuestionAnswer } from "../../shared/types";

/** The docked question card's state: which question is shown, and what the user picked or typed for each. */
export interface QuestionCardState {
  step: number;
  /** Highlighted row for the keyboard: an option index, or options.length for "Other…". */
  cursor: number;
  picks: Record<string, string[]>;
  other: Record<string, string>;
  /** "Other…" is chosen for this question (its text is the answer, or part of it when multi-select). */
  otherOn: Record<string, boolean>;
  /** A note the user adds beside their pick, and whether its field is open. */
  notes: Record<string, string>;
  noteOn: Record<string, boolean>;
}

export type QuestionCardAction =
  | { type: "pick"; label: string }
  | { type: "other-on" }
  | { type: "other-text"; text: string }
  | { type: "note-on" }
  | { type: "note-text"; text: string }
  | { type: "cursor"; delta: number }
  | { type: "next" }
  | { type: "back" };

export const initialCardState: QuestionCardState = { step: 0, cursor: 0, picks: {}, other: {}, otherOn: {}, notes: {}, noteOn: {} };

/** Rows a question offers: its options, plus "Other…" when allowed. */
export function rowCount(q: Question): number {
  return q.options.length + (q.allowOther ? 1 : 0);
}

export function questionCardReducer(questions: Question[], s: QuestionCardState, a: QuestionCardAction): QuestionCardState {
  const q = questions[s.step];
  if (!q) return s;
  switch (a.type) {
    case "pick": {
      const had = s.picks[q.id] ?? [];
      const picks = q.multiSelect ? (had.includes(a.label) ? had.filter((l) => l !== a.label) : [...had, a.label]) : [a.label];
      // A single pick replaces "Other…".
      const otherOn = q.multiSelect ? s.otherOn : { ...s.otherOn, [q.id]: false };
      return { ...s, picks: { ...s.picks, [q.id]: picks }, otherOn, cursor: Math.max(0, q.options.findIndex((o) => o.label === a.label)) };
    }
    case "other-on":
      return {
        ...s,
        otherOn: { ...s.otherOn, [q.id]: true },
        picks: q.multiSelect ? s.picks : { ...s.picks, [q.id]: [] },
        cursor: q.options.length,
      };
    case "other-text":
      return { ...s, other: { ...s.other, [q.id]: a.text }, otherOn: { ...s.otherOn, [q.id]: true } };
    case "note-on":
      return { ...s, noteOn: { ...s.noteOn, [q.id]: true } };
    case "note-text":
      return { ...s, notes: { ...s.notes, [q.id]: a.text }, noteOn: { ...s.noteOn, [q.id]: true } };
    case "cursor": {
      const n = rowCount(q);
      return n ? { ...s, cursor: (s.cursor + a.delta + n) % n } : s;
    }
    case "next":
      return s.step < questions.length - 1 ? { ...s, step: s.step + 1, cursor: 0 } : s;
    case "back":
      return s.step > 0 ? { ...s, step: s.step - 1, cursor: 0 } : s;
  }
}

/** One question's answer: the picked labels, plus the typed text when "Other…" is on. */
export function answerFor(q: Question, s: QuestionCardState): string[] {
  const picks = s.picks[q.id] ?? [];
  const typed = s.otherOn[q.id] ? (s.other[q.id] ?? "").trim() : "";
  return typed ? [...picks, typed] : picks;
}

/** Can the user move on from this question? A free-text question needs text; others need a pick. */
export function answered(q: Question, s: QuestionCardState): boolean {
  return answerFor(q, s).length > 0;
}

/** The whole card's answer; questions left blank are omitted (the agent takes its default). Notes ride along. */
export function cardAnswer(questions: Question[], s: QuestionCardState): QuestionAnswer {
  const answers: Record<string, string[]> = {};
  const notes: Record<string, string> = {};
  for (const q of questions) {
    const a = answerFor(q, s);
    if (a.length) answers[q.id] = a;
    const note = s.noteOn[q.id] ? (s.notes[q.id] ?? "").trim() : "";
    if (note) notes[q.id] = note;
  }
  return Object.keys(notes).length ? { answers, notes } : { answers };
}
