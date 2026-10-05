import { z } from "zod";
import type { Question, QuestionAnswer } from "../shared/types";
import type { HarnessTool, ToolContext } from "./agents/types";

/** The harness question tool, for agents whose own question tool doesn't reach the app (ACP: OpenCode's `question` isn't sent over ACP). */
export const ASK_USER_TOOL = "ask_user";

/** What the agent is told when the user skips its questions. */
export const SKIPPED_TEXT = "The user skipped the questions. Proceed with your recommended defaults and list them as assumptions.";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The renderer's answer, checked: anything malformed counts as a skip. */
export function questionAnswerOf(raw: unknown): QuestionAnswer {
  if (!isRecord(raw) || !isRecord(raw.answers)) return "dismiss";
  const answers: Record<string, string[]> = {};
  for (const [id, v] of Object.entries(raw.answers)) {
    if (Array.isArray(v)) answers[id] = v.filter((a): a is string => typeof a === "string");
  }
  const notes: Record<string, string> = {};
  if (isRecord(raw.notes)) for (const [id, v] of Object.entries(raw.notes)) if (typeof v === "string" && v.trim()) notes[id] = v.trim();
  return Object.keys(notes).length ? { answers, notes } : { answers };
}

/** Claude's AskUserQuestion input (also the ask_user tool's) as questions; ids are positional. */
export function fromClaudeQuestions(input: unknown): Question[] {
  const list = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
  return list.filter(isRecord).map((q, i) => ({
    id: `q${i}`,
    header: str(q.header),
    question: str(q.question),
    options: (Array.isArray(q.options) ? q.options : []).filter(isRecord).map((o) => ({
      label: str(o.label),
      description: str(o.description),
      ...(typeof o.preview === "string" && o.preview ? { preview: o.preview } : {}),
    })),
    multiSelect: q.multiSelect === true,
    // Claude's contract: the client always offers "Other" itself.
    allowOther: true,
  }));
}

/** Claude wants answers keyed by the question text; several picks are joined with ", ". */
export function claudeAnswers(questions: Question[], answer: Exclude<QuestionAnswer, "dismiss">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const given = answer.answers[q.id];
    if (given?.length) out[q.question] = given.join(", ");
  }
  return out;
}

/** Claude's per-question annotations: the user's note, and the preview of the option they picked. */
export function claudeAnnotations(questions: Question[], answer: Exclude<QuestionAnswer, "dismiss">): Record<string, { notes?: string; preview?: string }> | null {
  const out: Record<string, { notes?: string; preview?: string }> = {};
  for (const q of questions) {
    const notes = answer.notes?.[q.id];
    const preview = q.options.find((o) => o.preview && answer.answers[q.id]?.includes(o.label))?.preview;
    if (notes || preview) out[q.question] = { ...(notes ? { notes } : {}), ...(preview ? { preview } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

/** Codex's `item/tool/requestUserInput` questions; no options means a free-text answer. */
export function fromCodexQuestions(params: unknown): Question[] {
  const list = isRecord(params) && Array.isArray(params.questions) ? params.questions : [];
  return list.filter(isRecord).map((q, i) => {
    const options = (Array.isArray(q.options) ? q.options : []).filter(isRecord).map((o) => ({ label: str(o.label), description: str(o.description) }));
    return {
      id: str(q.id) || `q${i}`,
      header: str(q.header),
      question: str(q.question),
      options,
      multiSelect: false,
      allowOther: q.isOther === true || options.length === 0,
      ...(q.isSecret === true ? { secret: true } : {}),
    };
  });
}

/** Codex's request_user_input_async questions (`{ title, options?: string[] }` on an agentMessage); every one takes a typed answer too. */
export function fromCodexAsyncQuestions(raw: unknown): Question[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter(isRecord)
    .filter((q) => str(q.title).trim())
    .map((q, i) => ({
      id: `q${i}`,
      header: "",
      question: str(q.title),
      options: (Array.isArray(q.options) ? q.options : []).filter((o): o is string => typeof o === "string" && !!o.trim()).map((label) => ({ label, description: "" })),
      multiSelect: false,
      allowOther: true,
    }));
}

/** Codex's response shape: `{ answers: { [id]: { answers: string[] } } }`; a skip sends none. */
export function codexAnswers(answer: QuestionAnswer): { answers: Record<string, { answers: string[] }> } {
  if (answer === "dismiss") return { answers: {} };
  // A note rides as one more answer string, the way Codex's own TUI sends it.
  const ids = new Set([...Object.keys(answer.answers), ...Object.keys(answer.notes ?? {})]);
  return {
    answers: Object.fromEntries(
      [...ids].map((id) => {
        const note = answer.notes?.[id];
        return [id, { answers: [...(answer.answers[id] ?? []), ...(note ? [`user_note: ${note}`] : [])] }];
      }),
    ),
  };
}

/** The answers as the user's own message (an async question answered as the next message, or steered into the turn). */
export function answersMessage(questions: Question[], answer: QuestionAnswer): string {
  return answersText(questions, answer).replace(/^The user answered:/, "Answers to your questions:");
}

/** The answers as the text a tool result carries back to the agent. */
export function answersText(questions: Question[], answer: QuestionAnswer): string {
  if (answer === "dismiss") return SKIPPED_TEXT;
  const lines = questions.map((q) => {
    const given = answer.answers[q.id] ?? [];
    const note = answer.notes?.[q.id];
    return `- ${q.question}\n  Answer: ${given.length ? given.join(", ") : "(no answer; use your recommended default)"}${note ? `\n  Note: ${note}` : ""}`;
  });
  return `The user answered:\n${lines.join("\n")}`;
}

const option = z.object({
  label: z.string().describe("The choice, 1-5 words"),
  description: z.string().describe("What it means or what it trades off"),
});

/**
 * The ask_user tool, served to ACP agents on the tool server: the server knows
 * the calling thread from `?t=`, and `ask` puts the card in front of the user.
 */
export function askUserTool(ask: (threadId: string, questions: Question[], signal?: AbortSignal) => Promise<QuestionAnswer> | null): HarnessTool {
  const input = {
    questions: z
      .array(
        z.object({
          question: z.string().describe("The full question, ending with a question mark"),
          header: z.string().describe("A short label, at most 12 characters"),
          options: z.array(option).describe("2-4 distinct choices, your recommended one first with ' (Recommended)' at the end of its label; the user can always type their own answer"),
          multiSelect: z.boolean().optional().describe("Allow several choices"),
        }),
      )
      .describe("1-4 questions"),
  };
  return {
    name: ASK_USER_TOOL,
    description:
      "Ask the user multiple-choice questions and wait for the answers. Use it only for decisions that are the user's (preferences, trade-offs, scope) and that you can't settle by reading the project; never to ask permission to proceed.",
    input,
    autoAllow: true,
    run: async (args: unknown, ctx?: ToolContext) => {
      const questions = fromClaudeQuestions(args).slice(0, 4);
      if (!questions.length) return { text: "Give at least one question.", isError: true };
      const pending = ctx?.threadId ? ask(ctx.threadId, questions, ctx.signal) : null;
      if (!pending) return { text: "No one can answer right now. Proceed with your recommended defaults and list them as assumptions.", isError: true };
      return { text: answersText(questions, await pending) };
    },
  } as unknown as HarnessTool;
}
