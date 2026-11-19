// GU0 regressions: an unclosed ui fence stays inert, tap/select values are
// never clipped, replies go to the block's own thread and are awaited, an
// answered block stays used after a remount, and CSV export is formula-safe.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredEvent } from "../src/shared/types";
import { Choices } from "../src/renderer/src/genui/components/Choices";
import { Form } from "../src/renderer/src/genui/components/Form";
import { UiAnswersProvider, UiOriginProvider } from "../src/renderer/src/genui/origin";
import { sendUiReply } from "../src/renderer/src/genui/reply";
import { tableCsv } from "../src/renderer/src/genui/SmartTable";
import type { ChoicesSpec, FormSpec } from "../src/renderer/src/genui/types";
import { validateUi } from "../src/renderer/src/genui/validate";
import { parseBlocks } from "../src/renderer/src/streaming";
import { useStore } from "../src/renderer/src/store";

describe("unclosed ui fences", () => {
  it("a reply cut off inside a ui fence renders the body as plain code", () => {
    const blocks = parseBlocks('Pick one:\n\n```ui:choices\n{"options":["A","B"]}');
    expect(blocks.at(-1)).toEqual({ type: "code", text: '{"options":["A","B"]}', lang: "ui:choices" });
  });

  it("a closed ui fence is still a ui block", () => {
    const blocks = parseBlocks('```ui:choices\n{"options":["A","B"]}\n```');
    expect(blocks).toEqual([{ type: "ui", name: "choices", body: '{"options":["A","B"]}' }]);
  });

  it("an unclosed ordinary code fence is unchanged", () => {
    expect(parseBlocks("```ts\nconst a = 1;")).toEqual([{ type: "code", text: "const a = 1;", lang: "ts" }]);
  });
});

describe("tap and select values", () => {
  it("keeps a long choice exactly as written", () => {
    const long = "x".repeat(600);
    const spec = validateUi("choices", JSON.stringify({ options: [long, "short"] })) as ChoicesSpec;
    expect(spec.options[0]).toBe(long);
  });

  it("falls back to code rather than send a clipped value", () => {
    expect(validateUi("choices", JSON.stringify({ options: ["x".repeat(2_001), "b"] }))).toBeNull();
  });

  it("merges repeated options into one button", () => {
    const spec = validateUi("choices", JSON.stringify({ options: ["A", "B", "A"] })) as ChoicesSpec;
    expect(spec.options).toEqual(["A", "B"]);
  });

  it("keeps long select options whole, and needs two distinct ones", () => {
    const long = "y".repeat(700);
    const spec = validateUi("form", JSON.stringify({ fields: [{ id: "a", type: "select", options: [long, "b"] }] })) as FormSpec;
    expect(spec.fields[0]!.options).toEqual([long, "b"]);
    expect(validateUi("form", JSON.stringify({ fields: [{ id: "a", type: "select", options: ["b", "b"] }] }))).toBeNull();
  });
});

const user = (seq: number, text: string): StoredEvent => ({ seq, createdAt: 0, event: { kind: "user", text } }) as StoredEvent;
const inThread = (events: StoredEvent[], seq: number, node: React.ReactNode): string =>
  renderToStaticMarkup(
    <UiAnswersProvider threadId="t1" events={events}>
      <UiOriginProvider seq={seq}>{node}</UiOriginProvider>
    </UiAnswersProvider>,
  );

describe("answered blocks stay used", () => {
  const spec: ChoicesSpec = { name: "choices", options: ["Pro", "Team"] };

  it("an unanswered reply's choices are live", () => {
    const html = inThread([user(1, "hi")], 2, <Choices spec={spec} />);
    expect(html).not.toContain("disabled");
  });

  it("the choice the user sent shows picked and every button is locked", () => {
    const html = inThread([user(1, "hi"), user(5, "Team")], 2, <Choices spec={spec} />);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toMatch(/class="ui-choice on"[^>]*>Team</);
  });

  it("any later message locks the block, with nothing shown picked", () => {
    const html = inThread([user(1, "hi"), user(5, "something else")], 2, <Choices spec={spec} />);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain("ui-choice on");
  });

  it("a sent form reads Sent and stays locked", () => {
    const form: FormSpec = { name: "form", title: "Trip", fields: [{ id: "n", label: "N", type: "text" }] };
    const html = inThread([user(9, 'Form "Trip": n=3')], 4, <Form spec={form} />);
    expect(html).toContain("<fieldset disabled=\"\">");
    expect(html).toContain(">Sent</button>");
  });

  it("outside a transcript the block behaves as before (live)", () => {
    expect(renderToStaticMarkup(<Choices spec={spec} />)).not.toContain("disabled");
  });
});

describe("sendUiReply to the block's own thread", () => {
  const initial = useStore.getState();
  afterEach(() => useStore.setState(initial, true));

  it("sends to the origin thread, not the selected one, and waits for the result", async () => {
    const send = vi.fn(async () => false);
    useStore.setState({ selectedThreadId: "other", send, running: {}, events: { t2: [] } });
    expect(await sendUiReply("Pro", "t2")).toBe(false);
    expect(send).toHaveBeenCalledWith("Pro", undefined, "t2");
  });

  it("refuses a thread whose transcript is gone", async () => {
    const send = vi.fn(async () => true);
    useStore.setState({ selectedThreadId: "t2", send, running: {}, events: {} });
    expect(await sendUiReply("Pro", "t2")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("CSV export", () => {
  it("neutralises cells a spreadsheet would run as formulas", () => {
    expect(tableCsv(["a"], [["=SUM(A1:A9)"], ["+cmd"], ["-x"], ["@SUM(1)"], ["\tx"]])).toBe("a\n'=SUM(A1:A9)\n'+cmd\n'-x\n'@SUM(1)\n'\tx");
  });

  it("leaves plain numbers and ordinary text alone", () => {
    expect(tableCsv(["n", "t"], [["-3", "ok"], ["+1.5", "a=b"]])).toBe("n,t\n-3,ok\n+1.5,a=b");
  });

  it("still quotes after neutralising", () => {
    expect(tableCsv(["a"], [['=HYPERLINK("x")']])).toBe('a\n"\'=HYPERLINK(""x"")"');
  });
});
