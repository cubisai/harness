import { describe, expect, it } from "vitest";
import type { LlmMessage, ToolResult } from "../src/main/harness/llm/types";
import { CHARS_PER_TOKEN, estimateMessage, estimateMessages, estimateText } from "../src/main/harness/context/estimate";
import { MIN_SAVING, PROTECT_TOKENS, PRUNED_MARKER, PRUNED_MARKER_SAVED, isPruned, pruneToolOutputs, retentionFor } from "../src/main/harness/context/prune";

const result = (name: string, text: string, extra: Partial<ToolResult> = {}): ToolResult => ({ callId: `${name}:${text.length}`, name, text, ...extra });
const toolMsg = (...results: ToolResult[]): LlmMessage => ({ role: "tool", results });
const user = (text: string): LlmMessage => ({ role: "user", content: [{ type: "text", text }] });
const big = "x".repeat(5000);

describe("estimate", () => {
  it("rounds characters up to whole tokens", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(estimateText("")).toBe(0);
    expect(estimateText("abcd")).toBe(1);
    expect(estimateText("abcde")).toBe(2);
  });

  it("counts every user, assistant and tool-call part kind", () => {
    expect(estimateMessage(user("abcdefgh"))).toBe(2);
    expect(estimateMessage({ role: "user", content: [{ type: "image", mediaType: "image/png", data: "abc" }] })).toBe(1000);
    expect(estimateMessage({ role: "user", content: [{ type: "text", text: "abcd" }, { type: "image", mediaType: "image/png", data: "abc" }] })).toBe(1001);
    expect(estimateMessage({ role: "assistant", content: [{ type: "text", text: "abcdefgh" }, { type: "reasoning", text: "abcd" }] })).toBe(3);
    const name = "read";
    const input = { path: "a" };
    expect(estimateMessage({ role: "assistant", content: [{ type: "tool-call", id: "c", name, input }] })).toBe(estimateText(name + JSON.stringify(input)));
    expect(estimateMessage({ role: "assistant", content: [{ type: "tool-call", id: "c", name, input: {}, invalidInput: "{oops" }] })).toBe(estimateText(name + "{oops"));
  });

  it("counts tool results, adding a flat charge for an image", () => {
    expect(estimateMessage(toolMsg(result("read", "contents")))).toBe(estimateText("readcontents"));
    expect(estimateMessage(toolMsg(result("shot", "ok", { imagePng: "AAAA" })))).toBe(estimateText("shotok") + 1000);
    expect(estimateMessage(toolMsg(result("a", "one"), result("b", "two", { imagePng: "zz" })))).toBe(estimateText("aone") + estimateText("btwo") + 1000);
  });

  it("sums a whole message list", () => {
    const ms: LlmMessage[] = [user("abcd"), toolMsg(result("read", "content"))];
    expect(estimateMessages(ms)).toBe(estimateMessage(ms[0]!) + estimateMessage(ms[1]!));
  });
});

describe("pruneToolOutputs", () => {
  it("returns the same array when the saving is below the minimum", () => {
    const messages: LlmMessage[] = [user("go"), toolMsg(result("read", "small")), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", "tiny"))];
    const out = pruneToolOutputs(messages, { protect: 0, minSaving: MIN_SAVING });
    expect(out.messages).toBe(messages);
    expect(out.saved).toBe(0);
    expect(out.pruned).toBe(0);
  });

  it("replaces only old tool results and leaves user/assistant messages identical", () => {
    const old = toolMsg(result("read", big));
    const assistant: LlmMessage = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const newest = toolMsg(result("read", big));
    const messages: LlmMessage[] = [user("go"), old, assistant, newest];

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 10 });

    expect(out.messages).not.toBe(messages);
    expect((out.messages[1] as Extract<LlmMessage, { role: "tool" }>).results[0]!.text).toBe(PRUNED_MARKER);
    expect(out.messages[2]).toBe(assistant);
    expect((out.messages[3] as Extract<LlmMessage, { role: "tool" }>).results[0]!.text).toBe(big);
    expect(out.saved).toBe(estimateText(big) - estimateText(PRUNED_MARKER));
    expect(out.pruned).toBe(1);
  });

  it("never prunes a result produced by the skill tool", () => {
    const messages: LlmMessage[] = [user("go"), toolMsg(result("skill", big), result("read", big)), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 10 });
    const results = (out.messages[1] as Extract<LlmMessage, { role: "tool" }>).results;

    expect(results[0]!.text).toBe(big);
    expect(results[1]!.text).toBe(PRUNED_MARKER);
    expect(out.pruned).toBe(1);
  });

  it("respects a keep() predicate", () => {
    const messages: LlmMessage[] = [user("go"), toolMsg(result("read", big), result("grep", big)), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 10, keep: (r) => r.name === "read" });
    const results = (out.messages[1] as Extract<LlmMessage, { role: "tool" }>).results;

    expect(results[0]!.text).toBe(big);
    expect(results[1]!.text).toBe(PRUNED_MARKER);
    expect(out.pruned).toBe(1);
  });

  it("does not count an already-pruned result again", () => {
    const messages: LlmMessage[] = [user("go"), toolMsg(result("read", PRUNED_MARKER), result("read", big)), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 10 });

    expect(out.saved).toBe(estimateText(big) - estimateText(PRUNED_MARKER));
    expect(out.pruned).toBe(1);
  });

  it("never counts a result no longer than the marker", () => {
    const small = "tiny";
    const messages: LlmMessage[] = [
      user("go"),
      toolMsg(result("read", small)),
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      toolMsg(result("read", big)),
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      toolMsg(result("read", big)),
    ];

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 1 });

    // The short result frees nothing, so it is left verbatim and excluded from
    // both the count and the saving.
    expect((out.messages[1] as Extract<LlmMessage, { role: "tool" }>).results[0]!.text).toBe(small);
    expect(out.saved).toBe(estimateText(big) - estimateText(PRUNED_MARKER));
    expect(out.pruned).toBe(1);
  });

  it("does not count a lone short result at all", () => {
    const small = "tiny";
    const messages: LlmMessage[] = [user("go"), toolMsg(result("read", small)), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 1 });

    expect(out.messages).toBe(messages);
    expect(out.saved).toBe(0);
    expect(out.pruned).toBe(0);
  });

  it("never mutates the input messages or results", () => {
    const old = toolMsg(result("read", big));
    const messages: LlmMessage[] = [user("go"), old, { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];
    const before = structuredClone(messages);

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 10 });

    expect(messages).toEqual(before);
    expect((old as Extract<LlmMessage, { role: "tool" }>).results[0]!.text).toBe(big);
    const changed = (out.messages[1] as Extract<LlmMessage, { role: "tool" }>).results[0]!;
    expect(changed).not.toBe((old as Extract<LlmMessage, { role: "tool" }>).results[0]!);
  });

  it("drops imagePng from a pruned result but keeps isError", () => {
    const messages: LlmMessage[] = [user("go"), toolMsg(result("shot", big, { imagePng: "AAAA", isError: true })), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 10 });
    const pruned = (out.messages[1] as Extract<LlmMessage, { role: "tool" }>).results[0]!;

    expect(pruned.text).toBe(PRUNED_MARKER);
    expect(pruned.imagePng).toBeUndefined();
    expect(pruned.isError).toBe(true);
    expect(out.saved).toBe(estimateText(big) - estimateText(PRUNED_MARKER) + 1000);
  });

  it("leaves the newest tool message alone even with protect 0", () => {
    const newest = toolMsg(result("read", big));
    const messages: LlmMessage[] = [user("go"), newest];

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 1 });

    expect(out.messages).toBe(messages);
    expect((messages[1] as Extract<LlmMessage, { role: "tool" }>).results[0]!.text).toBe(big);
    expect(out.pruned).toBe(0);
  });

  it("prunes nothing when the whole transcript fits the protect budget", () => {
    const messages: LlmMessage[] = [user("go"), toolMsg(result("read", big)), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];

    const out = pruneToolOutputs(messages, { protect: estimateMessages(messages) + 1, minSaving: 1 });

    expect(out.messages).toBe(messages);
    expect(out.pruned).toBe(0);
  });

  it("keeps a bound() note's saved path and never calls save for it", () => {
    const note = `head\n${"y".repeat(2000)}\n\n[100 of 200 lines omitted; the full output is in /tmp/out/c1.txt (Read it with offset/limit, or Grep it)]`;
    const messages: LlmMessage[] = [user("go"), toolMsg(result("read", note)), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];
    let calls = 0;

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 1, save: (r) => (calls++, `/tmp/${r.callId}.txt`) });
    const pruned = (out.messages[1] as Extract<LlmMessage, { role: "tool" }>).results[0]!;

    expect(pruned.text).toBe(`${PRUNED_MARKER_SAVED} /tmp/out/c1.txt (Read it with offset/limit, or Grep it).]`);
    expect(calls).toBe(0);
  });

  it("calls save for a result without a reference and names the returned path", () => {
    const messages: LlmMessage[] = [user("go"), toolMsg(result("read", big)), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];
    let calls = 0;

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 1, save: (r) => (calls++, `/tmp/${r.callId}.txt`) });
    const pruned = (out.messages[1] as Extract<LlmMessage, { role: "tool" }>).results[0]!;

    expect(calls).toBe(1);
    expect(pruned.text).toBe(`${PRUNED_MARKER_SAVED} /tmp/read:5000.txt (Read it with offset/limit, or Grep it).]`);
  });

  it("falls back to the plain marker when save returns null", () => {
    const messages: LlmMessage[] = [user("go"), toolMsg(result("read", big)), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 1, save: () => null });
    const pruned = (out.messages[1] as Extract<LlmMessage, { role: "tool" }>).results[0]!;

    expect(pruned.text).toBe(PRUNED_MARKER);
  });

  it("never calls save when the saving is below the minimum", () => {
    const messages: LlmMessage[] = [user("go"), toolMsg(result("read", big)), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];
    let calls = 0;

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 100_000, save: (r) => (calls++, `/tmp/${r.callId}.txt`) });

    expect(out.messages).toBe(messages);
    expect(out.saved).toBe(0);
    expect(calls).toBe(0);
  });

  it("recognises both markers and skips an already-pruned result on a second pass", () => {
    expect(isPruned(PRUNED_MARKER)).toBe(true);
    expect(isPruned(`${PRUNED_MARKER_SAVED} /tmp/a.txt (Read it with offset/limit, or Grep it).]`)).toBe(true);
    expect(isPruned(big)).toBe(false);

    const saved = `${PRUNED_MARKER_SAVED} /tmp/a.txt (Read it with offset/limit, or Grep it).]`;
    const messages: LlmMessage[] = [user("go"), toolMsg(result("read", saved), result("read", big)), { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolMsg(result("read", big))];

    const out = pruneToolOutputs(messages, { protect: 0, minSaving: 1 });

    expect(out.pruned).toBe(1);
    expect((out.messages[1] as Extract<LlmMessage, { role: "tool" }>).results[0]!.text).toBe(saved);
  });
});

describe("retentionFor", () => {
  it("keeps today's constants for an unknown window", () => {
    expect(retentionFor(0)).toEqual({ protect: PROTECT_TOKENS, minSaving: MIN_SAVING });
    expect(retentionFor(-1)).toEqual({ protect: PROTECT_TOKENS, minSaving: MIN_SAVING });
  });

  it("caps a large window at today's constants", () => {
    expect(retentionFor(200_000)).toEqual({ protect: 40_000, minSaving: 20_000 });
  });

  it("scales the budgets down with the window", () => {
    expect(retentionFor(32_000)).toEqual({ protect: 8_000, minSaving: 4_000 });
    expect(retentionFor(100_000)).toEqual({ protect: 20_000, minSaving: 10_000 });
  });
});
