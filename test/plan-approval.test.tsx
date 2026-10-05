import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanRequest } from "../src/shared/types";
import { PlanApprovalCardBody, PlanApprovalCardView } from "../src/renderer/src/components/PlanApprovalCard";

const request: PlanRequest = {
  requestId: "r1",
  threadId: "t1",
  plan: "# Plan\n\n**Goal:** ship it\n\n- step one\n- step two",
};

/** Every button in a directly-called component's element tree, with its label and onClick. */
function buttons(element: unknown): { text: string; onClick?: () => void }[] {
  const found: { text: string; onClick?: () => void }[] = [];
  const text = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    if (node && typeof node === "object" && "props" in node) {
      return text((node as { props?: { children?: unknown } }).props?.children);
    }
    return "";
  };
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (!("props" in el) || !el.props) return;
    if (el.type === "button") found.push({ text: text(el.props.children), onClick: el.props.onClick as (() => void) | undefined });
    visit(el.props.children);
  };
  visit(element);
  return found;
}

describe("PlanApprovalCard", () => {
  it("renders the plan as markdown under the heading", () => {
    const onRespond = vi.fn();
    const html = renderToStaticMarkup(<PlanApprovalCardView request={request} onRespond={onRespond} />);
    expect(html).toContain("Ready to build?");
    expect(html).toContain("<h1>Plan</h1>");
    expect(html).toContain("<strong>Goal:</strong>");
    expect(html).toContain("Yes, auto-accept edits");
    expect(html).toContain("Yes, manually approve edits");
    expect(html).toContain("Keep planning");
    // It waits for the user; rendering never answers on its own.
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("answers auto when Yes, auto-accept edits is clicked", () => {
    const onRespond = vi.fn();
    const body = PlanApprovalCardBody({ request, keeping: false, feedback: "", onKeep: () => {}, onCancel: () => {}, onFeedback: () => {}, onRespond });
    buttons(body)
      .find((b) => b.text.includes("auto-accept"))!
      .onClick!();
    expect(onRespond).toHaveBeenCalledWith("auto");
  });

  it("answers manual when Yes, manually approve edits is clicked", () => {
    const onRespond = vi.fn();
    const body = PlanApprovalCardBody({ request, keeping: false, feedback: "", onKeep: () => {}, onCancel: () => {}, onFeedback: () => {}, onRespond });
    buttons(body)
      .find((b) => b.text.includes("manually approve"))!
      .onClick!();
    expect(onRespond).toHaveBeenCalledWith("manual");
  });

  it("opens the feedback box from Keep planning", () => {
    const onKeep = vi.fn();
    const body = PlanApprovalCardBody({ request, keeping: false, feedback: "", onKeep, onCancel: () => {}, onFeedback: () => {}, onRespond: () => {} });
    buttons(body)
      .find((b) => b.text === "Keep planning")!
      .onClick!();
    expect(onKeep).toHaveBeenCalled();
  });

  it("sends { keep: feedback } from Send feedback", () => {
    const onRespond = vi.fn();
    const body = PlanApprovalCardBody({ request, keeping: true, feedback: "add tests", onKeep: () => {}, onCancel: () => {}, onFeedback: () => {}, onRespond });
    buttons(body)
      .find((b) => b.text === "Send feedback")!
      .onClick!();
    expect(onRespond).toHaveBeenCalledWith({ keep: "add tests" });
  });

  it("opens the plan in the panel from Open in panel, and shows no such button without a handler", () => {
    const onOpen = vi.fn();
    const props = { request, keeping: false, feedback: "", onKeep: () => {}, onCancel: () => {}, onFeedback: () => {}, onRespond: () => {} };
    buttons(PlanApprovalCardBody({ ...props, onOpen }))
      .find((b) => b.text === "Open in panel")!
      .onClick!();
    expect(onOpen).toHaveBeenCalled();
    expect(buttons(PlanApprovalCardBody(props)).some((b) => b.text === "Open in panel")).toBe(false);
  });
});
