import { describe, expect, it } from "vitest";
import type { AssistantPart, LlmMessage, UserPart } from "../src/main/harness/llm/types";
import {
  compactedHistory,
  isSummaryMessage,
  splitForCompaction,
  SUMMARY_CLOSE,
  SUMMARY_OPEN,
  summaryPrompt,
  TOOL_OUTPUT_CHARS,
  touchedFiles,
} from "../src/main/harness/context/compact";

const text = (t: string): UserPart => ({ type: "text", text: t });
const say = (t: string): AssistantPart => ({ type: "text", text: t });
const call = (id: string, name: string, input: Record<string, unknown>): AssistantPart => ({ type: "tool-call", id, name, input });
const user = (...content: UserPart[]): LlmMessage => ({ role: "user", content });
const assistant = (...content: AssistantPart[]): LlmMessage => ({ role: "assistant", content });
const tool = (callId: string, name: string, text: string): LlmMessage => ({ role: "tool", results: [{ callId, name, text }] });
const summaryMessage = (body: string): LlmMessage => user(text(`${SUMMARY_OPEN}\n${body}\n${SUMMARY_CLOSE}`));

describe("splitForCompaction", () => {
  it("never splits an assistant tool-call from its following results", () => {
    const messages: LlmMessage[] = [
      user(text("start")),
      assistant(call("c1", "read", { path: "a.ts" })),
      tool("c1", "read", "a"),
      assistant(call("c2", "read", { path: "b.ts" })),
      tool("c2", "read", "b"),
      user(text("next")),
      assistant(say("done")),
    ];
    const { head, tail } = splitForCompaction(messages, 2);
    expect(tail).toEqual(messages.slice(5));
    expect(tail[0]!.role).toBe("user");
    // The head ends on a whole step, not a stranded tool result.
    expect(head.at(-1)!.role).toBe("tool");
    expect(head.at(-2)!.role).toBe("assistant");
    expect((head.at(-2) as Extract<LlmMessage, { role: "assistant" }>).content).toContainEqual(call("c2", "read", { path: "b.ts" }));
  });

  it("keeps a tiny history whole", () => {
    const messages: LlmMessage[] = [user(text("hi")), assistant(say("hello"))];
    const { head, tail } = splitForCompaction(messages, 8_000);
    expect(head).toEqual([]);
    expect(tail).toEqual(messages);

    const single: LlmMessage[] = [user(text("hi"))];
    expect(splitForCompaction(single, 8_000)).toEqual({ head: [], tail: single });
  });

  it("splits a single long agent turn at an assistant step after a tool batch", () => {
    const step = (i: number): LlmMessage[] => [assistant(call(`c${i}`, "read", { path: `f${i}.ts` })), tool(`c${i}`, "read", "x".repeat(8_000))];
    // One user message opens a turn of ten assistant -> tool steps (~2k tokens each).
    const messages: LlmMessage[] = [user(text("start")), ...Array.from({ length: 10 }, (_, i) => step(i)).flat()];

    const { head, tail } = splitForCompaction(messages, 6_000);
    const start = messages.length - tail.length;

    // The split lands mid-turn: the tail opens at an assistant step whose
    // preceding message is the tool batch that step follows.
    expect(start).toBeGreaterThan(1);
    expect(tail[0]!.role).toBe("assistant");
    expect(messages[start - 1]!.role).toBe("tool");
    expect(head.at(-1)!.role).toBe("tool");
    expect(head.at(-2)!.role).toBe("assistant");

    // No assistant tool-call in the head is left without its tool result.
    for (let i = 0; i < start; i++) {
      const m = messages[i]!;
      if (m.role !== "assistant" || !m.content.some((p) => p.type === "tool-call")) continue;
      expect(messages[i + 1]!.role).toBe("tool");
      expect(i + 1).toBeLessThan(start);
    }
  });

  it("puts an opening summary in the head even when nothing else reaches the budget", () => {
    const summary = summaryMessage("earlier work");
    const messages: LlmMessage[] = [summary, assistant(say("a")), user(text("new question")), assistant(say("answer"))];
    const { head, tail } = splitForCompaction(messages, 999_999);
    expect(head[0]).toBe(summary);
    expect(tail).toEqual(messages.slice(2));
    expect(tail[0]!.role).toBe("user");
  });
});

describe("touchedFiles", () => {
  it("collects paths from read, write and edit calls", () => {
    const messages: LlmMessage[] = [
      assistant(
        call("a", "read", { path: "src/a.ts" }),
        call("b", "write", { path: "src/b.ts" }),
        call("c", "edit", { path: "src/c.ts" }),
      ),
    ];
    expect(touchedFiles(messages)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("reads apply_patch markers including Move to", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+hi",
      "*** Update File: src/old.ts",
      "*** Move to: src/moved.ts",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n");
    const messages: LlmMessage[] = [assistant(call("p", "apply_patch", { patch }))];
    expect(touchedFiles(messages)).toEqual(["src/new.ts", "src/old.ts", "src/moved.ts", "src/gone.ts"]);
  });

  it("dedupes and keeps first-seen order", () => {
    const messages: LlmMessage[] = [
      assistant(call("a", "read", { path: "x.ts" })),
      assistant(call("b", "edit", { path: "y.ts" }), call("c", "read", { path: "x.ts" })),
      assistant(call("d", "apply_patch", { patch: "*** Add File: x.ts\n" })),
    ];
    expect(touchedFiles(messages)).toEqual(["x.ts", "y.ts"]);
  });

  it("ignores other tools and non-string paths, and caps at 50", () => {
    const messages: LlmMessage[] = [assistant(call("a", "bash", { command: "ls" }), call("b", "read", { path: 42 }))];
    expect(touchedFiles(messages)).toEqual([]);

    const many: LlmMessage[] = [assistant(...Array.from({ length: 60 }, (_, i) => call(`c${i}`, "read", { path: `f${i}.ts` })))];
    const paths = touchedFiles(many);
    expect(paths).toHaveLength(50);
    expect(paths[0]).toBe("f0.ts");
    expect(paths.at(-1)).toBe("f49.ts");
  });
});

describe("summaryPrompt", () => {
  it("cuts long tool output with an omitted-from-transcript note and leaves short output alone", () => {
    const long = "z".repeat(TOOL_OUTPUT_CHARS + 100);
    const longPrompt = summaryPrompt([user(text("go")), assistant(call("c", "read", { path: "a.ts" })), tool("c", "read", long)]);
    expect(longPrompt.user).toContain(
      `Tool result read: ${"z".repeat(TOOL_OUTPUT_CHARS)} …[the rest of this output is omitted from this transcript only; the tool returned it in full]`,
    );
    expect(longPrompt.user).not.toContain("z".repeat(TOOL_OUTPUT_CHARS + 1));

    const shortPrompt = summaryPrompt([user(text("go")), assistant(call("c", "read", { path: "a.ts" })), tool("c", "read", "brief")]);
    expect(shortPrompt.user).toContain("Tool result read: brief");
    expect(shortPrompt.user).not.toContain("omitted from this transcript");
  });

  it("tells the summariser shortened tool output is not a tool limitation", () => {
    const prompt = summaryPrompt([user(text("go")), assistant(say("working"))]);
    expect(prompt.system).toContain("Tool outputs in the transcript may be shortened for this summary; don't treat that as a tool limitation.");
  });

  it("lists touched files when there are any", () => {
    const withFiles = summaryPrompt([user(text("go")), assistant(call("c", "edit", { path: "src/a.ts" })), tool("c", "edit", "ok")]);
    expect(withFiles.user).toContain("Files touched so far:\n- src/a.ts");

    const withoutFiles = summaryPrompt([user(text("go")), assistant(say("nothing yet"))]);
    expect(withoutFiles.user).not.toContain("Files touched so far");
  });

  it("appends a focus line only when a non-empty focus is given", () => {
    const messages: LlmMessage[] = [user(text("go")), assistant(say("working"))];
    expect(summaryPrompt(messages).user).not.toContain("Focus");
    expect(summaryPrompt(messages, { focus: "the auth flow" }).user).toContain("Focus the summary on: the auth flow");
    expect(summaryPrompt(messages, { focus: "   " }).user).not.toContain("Focus the summary on");
  });

  it("carries the exact template and the update instruction only after a summary", () => {
    const fresh = summaryPrompt([user(text("go")), assistant(say("hi"))]);
    for (const heading of ["## Objective", "## Important Details", "## Work State", "## Next Move", "## Relevant Files"]) {
      expect(fresh.system).toContain(heading);
    }
    expect(fresh.system).not.toContain("Update the previous summary");

    const updating = summaryPrompt([summaryMessage("old"), user(text("go"))]);
    expect(updating.system).toContain("Update the previous summary with the newer messages");
  });

  it("drops leading blocks with an omission line when maxTokens is exceeded", () => {
    const head: LlmMessage[] = [user(text("a".repeat(400))), assistant(say("b".repeat(400))), user(text("c".repeat(400)))];

    const prompt = summaryPrompt(head, { maxTokens: 200 });
    expect(prompt.user).toContain("[Earlier messages omitted to fit the summarizer's context.]");
    expect(prompt.user).toContain("User: cccc");
    expect(prompt.user).not.toContain("aaaa");
    expect(prompt.user).not.toContain("bbbb");

    // Small enough to fit, so nothing is dropped and no omission line appears.
    const whole = summaryPrompt(head, { maxTokens: 999 });
    expect(whole.user).not.toContain("Earlier messages omitted");
    expect(whole.user).toContain("aaaa");
  });

  it("always keeps a leading prior-summary block when dropping to fit", () => {
    const head: LlmMessage[] = [summaryMessage("old work"), user(text("a".repeat(4_000))), assistant(say("b".repeat(4_000)))];

    const prompt = summaryPrompt(head, { maxTokens: 50 });

    expect(prompt.user).toContain("Earlier messages omitted to fit the summarizer's context.");
    expect(prompt.user).toContain("<conversation-summary>");
    expect(prompt.user).not.toContain("aaaa");
    expect(prompt.user).not.toContain("bbbb");
    expect(prompt.system).toContain("Update the previous summary");
  });

  it("keeps the files block and focus line even when dropping to fit", () => {
    const head: LlmMessage[] = [user(text("a".repeat(4_000))), assistant(call("c", "edit", { path: "src/a.ts" })), tool("c", "edit", "ok")];

    const prompt = summaryPrompt(head, { maxTokens: 20, focus: "the auth flow" });

    expect(prompt.user).toContain("Earlier messages omitted");
    expect(prompt.user).toContain("Files touched so far:\n- src/a.ts");
    expect(prompt.user).toContain("Focus the summary on: the auth flow");
  });
});

describe("compactedHistory", () => {
  it("frames the trimmed summary and keeps the tail as separate messages", () => {
    const tail: LlmMessage[] = [user(text("more")), assistant(say("ok"))];
    const out = compactedHistory("  did some work  ", tail);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: `${SUMMARY_OPEN}\nThis conversation was compacted. Summary of the earlier part:\n\ndid some work\n${SUMMARY_CLOSE}`,
        },
      ],
    });
    expect(isSummaryMessage(out[0]!)).toBe(true);
    expect(out.slice(1)).toEqual(tail);
  });

  it("does not merge two user turns in a row", () => {
    const out = compactedHistory("s", [user(text("next"))]);
    expect(out.map((m) => m.role)).toEqual(["user", "user"]);
    expect(out[1]).not.toBe(out[0]);
  });

  it("keeps an assistant first in a mid-turn tail after the summary", () => {
    const tail: LlmMessage[] = [assistant(say("continuing")), tool("c", "read", "x")];
    const out = compactedHistory("s", tail);

    // The summary user turn is directly followed by an assistant step: valid
    // alternation, so the tail is kept verbatim.
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(isSummaryMessage(out[0]!)).toBe(true);
    expect(out.slice(1)).toEqual(tail);
  });
});

describe("isSummaryMessage", () => {
  it("matches only user turns opening with the summary marker", () => {
    expect(isSummaryMessage(summaryMessage("x"))).toBe(true);
    expect(isSummaryMessage(user(text("hello")))).toBe(false);
    expect(isSummaryMessage(assistant(say(`${SUMMARY_OPEN} nope`)))).toBe(false);
    expect(isSummaryMessage(user({ type: "image", mediaType: "image/png", data: "abc" }))).toBe(false);
    expect(isSummaryMessage(user({ type: "image", mediaType: "image/png", data: "abc" }, text(`${SUMMARY_OPEN} later`)))).toBe(true);
  });
});
