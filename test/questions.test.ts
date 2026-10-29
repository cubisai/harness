import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import type { Question } from "../src/shared/types";
import { startToolServer, withProject, withThread } from "../src/main/mcp-http";
import {
  ASK_USER_TOOL,
  SKIPPED_TEXT,
  answersText,
  askUserTool,
  claudeAnnotations,
  claudeAnswers,
  codexAnswers,
  fromClaudeQuestions,
  fromCodexQuestions,
  questionAnswerOf,
} from "../src/main/questions";
import { answered, cardAnswer, initialCardState, questionCardReducer } from "../src/renderer/src/question-card";
import { closeAfter } from "./helpers";

const claudeInput = {
  questions: [
    { question: "How should I format the output?", header: "Format", multiSelect: false, options: [{ label: "Summary", description: "Brief" }, { label: "Detailed", description: "Full", preview: "```\nlong\n```" }] },
    { question: "Which sections?", header: "Sections", multiSelect: true, options: [{ label: "Intro", description: "" }, { label: "Outro", description: "" }] },
  ],
};

describe("Claude AskUserQuestion mapping", () => {
  it("reads questions with positional ids, previews and an Other answer", () => {
    const qs = fromClaudeQuestions(claudeInput);
    expect(qs.map((q) => [q.id, q.header, q.multiSelect, q.allowOther])).toEqual([
      ["q0", "Format", false, true],
      ["q1", "Sections", true, true],
    ]);
    expect(qs[0]!.options[1]!.preview).toContain("long");
    expect(qs[0]!.options[0]).not.toHaveProperty("preview");
  });

  it("keys answers by question text and joins several picks", () => {
    const qs = fromClaudeQuestions(claudeInput);
    expect(claudeAnswers(qs, { answers: { q0: ["my own words"], q1: ["Intro", "Outro"] } })).toEqual({
      "How should I format the output?": "my own words",
      "Which sections?": "Intro, Outro",
    });
    // An unanswered question is left out, so Claude takes its default.
    expect(claudeAnswers(qs, { answers: { q1: ["Intro"] } })).toEqual({ "Which sections?": "Intro" });
  });

  it("survives malformed input", () => {
    expect(fromClaudeQuestions(null)).toEqual([]);
    expect(fromClaudeQuestions({ questions: [null, { question: 3 }] })).toEqual([
      { id: "q0", header: "", question: "", options: [], multiSelect: false, allowOther: true },
    ]);
  });
});

describe("Codex request_user_input mapping", () => {
  const params = {
    threadId: "t",
    turnId: "u",
    itemId: "i",
    isBlocking: true,
    questions: [
      { id: "scope", header: "Scope", question: "Which scope?", isOther: false, options: [{ label: "Project", description: "" }, { label: "Global", description: "" }] },
      { id: "token", header: "Token", question: "Paste the token", isSecret: true, options: null },
    ],
  };

  it("keeps Codex's ids, and a question without options is free text", () => {
    const qs = fromCodexQuestions(params);
    expect(qs[0]).toMatchObject({ id: "scope", allowOther: false, multiSelect: false });
    expect(qs[1]).toMatchObject({ id: "token", options: [], allowOther: true, secret: true });
  });

  it("answers by id, and a skip answers nothing", () => {
    expect(codexAnswers({ answers: { scope: ["Project"], token: ["abc"] } })).toEqual({ answers: { scope: { answers: ["Project"] }, token: { answers: ["abc"] } } });
    expect(codexAnswers("dismiss")).toEqual({ answers: {} });
  });
});

describe("answers from the renderer", () => {
  it("keeps only string arrays; anything else is a skip", () => {
    expect(questionAnswerOf({ answers: { a: ["x", 2], b: "y" } })).toEqual({ answers: { a: ["x"] } });
    expect(questionAnswerOf("dismiss")).toBe("dismiss");
    expect(questionAnswerOf(null)).toBe("dismiss");
  });

  it("tells the agent what was answered or skipped", () => {
    const qs = fromClaudeQuestions(claudeInput);
    expect(answersText(qs, "dismiss")).toBe(SKIPPED_TEXT);
    const text = answersText(qs, { answers: { q0: ["Summary"] } });
    expect(text).toContain("How should I format the output?\n  Answer: Summary");
    expect(text).toContain("use your recommended default");
  });
});

describe("ask_user over the tool server", () => {
  async function connect(url: string, token: string): Promise<Client> {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }

  it("is served only on a thread's URL, and asks for that thread", async () => {
    const ask = vi.fn(async (_threadId: string, qs: Question[]) => ({ answers: { [qs[0]!.id]: ["Summary"] } }));
    const echo = { name: "echo", description: "Echo", input: {}, autoAllow: true, run: async () => ({ text: "echo" }) };
    const server = await startToolServer(() => [echo], undefined, undefined, () => [askUserTool(ask)]);
    closeAfter(() => void server.close());

    const plain = await connect(withProject(server.url, "p1"), server.token);
    expect((await plain.listTools()).tools.map((t) => t.name)).not.toContain(ASK_USER_TOOL);
    await plain.close();

    const client = await connect(withThread(withProject(server.url, "p1"), "thread-9"), server.token);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(ASK_USER_TOOL);
    const res = await client.callTool({ name: ASK_USER_TOOL, arguments: claudeInput });
    await client.close();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toBe("thread-9");
    expect((res.content as { text: string }[])[0]!.text).toContain("Answer: Summary");
  });

  it("errors without a running turn to answer it", async () => {
    const tool = askUserTool(() => null);
    expect(await tool.run(claudeInput as never, { threadId: "t" })).toMatchObject({ isError: true });
    expect(await tool.run({ questions: [] } as never, { threadId: "t" })).toMatchObject({ isError: true });
  });
});

describe("question card state", () => {
  const qs = fromClaudeQuestions(claudeInput);
  const run = (...actions: Parameters<typeof questionCardReducer>[2][]) => actions.reduce((s, a) => questionCardReducer(qs, s, a), initialCardState);

  it("a single pick replaces the last one and Other", () => {
    const s = run({ type: "other-text", text: "mine" }, { type: "pick", label: "Summary" }, { type: "pick", label: "Detailed" });
    expect(cardAnswer(qs, s)).toEqual({ answers: { q0: ["Detailed"] } });
  });

  it("multi-select toggles and adds Other text", () => {
    const s = run({ type: "next" }, { type: "pick", label: "Intro" }, { type: "pick", label: "Outro" }, { type: "pick", label: "Intro" }, { type: "other-text", text: " Appendix " });
    expect(s.step).toBe(1);
    expect(cardAnswer(qs, s)).toEqual({ answers: { q1: ["Outro", "Appendix"] } });
  });

  it("needs an answer to move on, and steps stay in range", () => {
    expect(answered(qs[0]!, initialCardState)).toBe(false);
    const s = run({ type: "back" }, { type: "next" }, { type: "next" }, { type: "next" });
    expect(s.step).toBe(1);
    expect(run({ type: "cursor", delta: -1 }).cursor).toBe(2); // wraps to "Other…"
  });
});

describe("tool rows for questions and plans", () => {
  it("summarize as their text, not JSON", async () => {
    const { summarizeToolInput } = await import("../src/main/agents/summarize");
    expect(summarizeToolInput("AskUserQuestion", claudeInput)).toBe("How should I format the output? (+1 more)");
    expect(summarizeToolInput("request_user_input_async", { questions: [{ title: "Free-form or fixed?" }] })).toBe("Free-form or fixed?");
    expect(summarizeToolInput("ExitPlanMode", { plan: "\n# Plan: Tags on notes\n\nbody" })).toBe("Plan: Tags on notes");
  });
});

describe("notes beside an answer", () => {
  const qs = fromClaudeQuestions(claudeInput);

  it("Claude gets the note and the picked option's preview as annotations", () => {
    expect(claudeAnnotations(qs, { answers: { q0: ["Detailed"], q1: ["Intro"] }, notes: { q0: "keep it under a page" } })).toEqual({
      "How should I format the output?": { notes: "keep it under a page", preview: "```\nlong\n```" },
    });
    expect(claudeAnnotations(qs, { answers: { q0: ["Summary"] } })).toBeNull();
  });

  it("Codex gets the note as one more answer, even on a question left blank", () => {
    expect(codexAnswers({ answers: { scope: ["Project"] }, notes: { scope: "only for now", other: "x" } })).toEqual({
      answers: { scope: { answers: ["Project", "user_note: only for now"] }, other: { answers: ["user_note: x"] } },
    });
  });

  it("ask_user's text carries the note; malformed notes are dropped", () => {
    expect(answersText(qs, { answers: { q0: ["Summary"] }, notes: { q0: "bullets" } })).toContain("Answer: Summary\n  Note: bullets");
    expect(questionAnswerOf({ answers: { q0: ["A"] }, notes: { q0: "  hi ", q1: 3, q2: " " } })).toEqual({ answers: { q0: ["A"] }, notes: { q0: "hi" } });
  });

  it("the card sends notes only for open, non-empty note fields", () => {
    const run = (...actions: Parameters<typeof questionCardReducer>[2][]) => actions.reduce((s, a) => questionCardReducer(qs, s, a), initialCardState);
    expect(cardAnswer(qs, run({ type: "pick", label: "Summary" }, { type: "note-text", text: " short please " }))).toEqual({ answers: { q0: ["Summary"] }, notes: { q0: "short please" } });
    expect(cardAnswer(qs, run({ type: "pick", label: "Summary" }, { type: "note-on" }))).toEqual({ answers: { q0: ["Summary"] } });
  });
});
