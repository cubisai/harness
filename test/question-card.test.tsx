import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { QuestionRequest } from "../src/shared/types";
import { QuestionCardBody } from "../src/renderer/src/components/QuestionCard";
import { initialCardState, type QuestionCardState } from "../src/renderer/src/question-card";

const request: QuestionRequest = {
  requestId: "r1",
  threadId: "t1",
  questions: [
    { id: "q0", header: "Format", question: "Which format?", options: [{ label: "Summary", description: "Brief" }, { label: "Detailed", description: "Full", preview: "**mock**" }], multiSelect: false, allowOther: true },
    { id: "q1", header: "Name", question: "What name?", options: [], multiSelect: false, allowOther: true },
  ],
};

function body(state: QuestionCardState = initialCardState, onRespond = vi.fn(), dispatch = vi.fn()) {
  return { el: QuestionCardBody({ request, state, waiting: 1, dispatch, onRespond }), onRespond, dispatch };
}

/** Every button in a directly-called component's element tree, with its label and onClick. */
function buttons(element: unknown): { text: string; disabled?: boolean; onClick?: () => void }[] {
  const found: { text: string; disabled?: boolean; onClick?: () => void }[] = [];
  const text = (node: unknown): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    if (node && typeof node === "object" && "props" in node) return text((node as { props?: { children?: unknown } }).props?.children);
    return "";
  };
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (!el.props) return;
    if (el.type === "button") found.push({ text: text(el.props.children), disabled: el.props.disabled as boolean | undefined, onClick: el.props.onClick as (() => void) | undefined });
    visit(el.props.children);
  };
  visit(element);
  return found;
}

describe("QuestionCard", () => {
  it("shows the question, its options, Other, the step and the queue", () => {
    const html = renderToStaticMarkup(body().el);
    expect(html).toContain("Which format?");
    expect(html).toContain("Summary");
    expect(html).toContain("Other…");
    expect(html).toContain("1 of 2");
    expect(html).toContain("+1 waiting");
    // The first option has the cursor, so its preview shows... only when it has one.
    expect(html).toContain("No preview");
  });

  it("Next is disabled until something is picked", () => {
    expect(buttons(body().el).find((b) => b.text === "Next")!.disabled).toBe(true);
    const picked = { ...initialCardState, picks: { q0: ["Detailed"] } };
    expect(buttons(body(picked).el).find((b) => b.text === "Next")!.disabled).toBe(false);
  });

  it("a single pick moves on to the next question", () => {
    const { el, dispatch } = body();
    buttons(el).find((b) => b.text.includes("Detailed"))!.onClick!();
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual([{ type: "pick", label: "Detailed" }, { type: "next" }]);
  });

  it("Skip answers dismiss; Submit on the last question sends every answer", () => {
    const skip = body();
    buttons(skip.el).find((b) => b.text === "Skip")!.onClick!();
    expect(skip.onRespond).toHaveBeenCalledWith("dismiss");

    const last: QuestionCardState = { ...initialCardState, step: 1, picks: { q0: ["Summary"] }, other: { q1: "Ada" }, otherOn: { q1: true } };
    const done = body(last);
    const html = renderToStaticMarkup(done.el);
    expect(html).toContain("Type your answer");
    buttons(done.el).find((b) => b.text === "Submit")!.onClick!();
    expect(done.onRespond).toHaveBeenCalledWith({ answers: { q0: ["Summary"], q1: ["Ada"] } });
  });
});
