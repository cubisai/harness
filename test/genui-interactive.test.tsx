import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formReply } from "../src/renderer/src/genui/components/Form";
import { statMarkdown } from "../src/renderer/src/genui/components/Stat";
import { sendUiReply } from "../src/renderer/src/genui/reply";
import type { FormSpec } from "../src/renderer/src/genui/types";
import { validateUi } from "../src/renderer/src/genui/validate";
import { Markdown } from "../src/renderer/src/markdown";
import { useStore } from "../src/renderer/src/store";

const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);
const fence = (name: string, body: string): string => `\`\`\`ui:${name}\n${body}\n\`\`\``;

describe("interactive UI blocks", () => {
  const initial = useStore.getState();
  afterEach(() => useStore.setState(initial, true));

  it("reads choices, form and stat from the line form", () => {
    expect(validateUi("choices", "# Which plan?\n- Free\nPro\nTeam")).toEqual({ name: "choices", title: "Which plan?", options: ["Free", "Pro", "Team"] });
    expect(validateUi("form", "# Trip\nbudget | Budget | number\nregion | Region | EU/US/Asia\nflex | Flexible dates | yes/no\nnote | Anything else")).toEqual({
      name: "form",
      title: "Trip",
      fields: [
        { id: "budget", label: "Budget", type: "number" },
        { id: "region", label: "Region", type: "select", options: ["EU", "US", "Asia"] },
        { id: "flex", label: "Flexible dates", type: "toggle" },
        { id: "note", label: "Anything else", type: "text" },
      ],
    });
    expect(validateUi("stat", "Users | 12,400 | +8%\nChurn | 2.1% | -0.3pt")).toEqual({
      name: "stat",
      stats: [
        { label: "Users", value: "12,400", delta: "+8%" },
        { label: "Churn", value: "2.1%", delta: "-0.3pt" },
      ],
    });
  });

  it("refuses oversized or malformed blocks", () => {
    expect(validateUi("choices", Array.from({ length: 7 }, (_, i) => `o${i}`).join("\n"))).toBeNull();
    expect(validateUi("form", "a | A\na | Again")).toBeNull(); // duplicate id
    expect(validateUi("form", "bad id | X")).toBeNull();
    expect(validateUi("form", JSON.stringify({ fields: [{ id: "s", type: "select", options: ["only"] }] }))).toBeNull();
    expect(validateUi("stat", "A | 1\nB | 2\nC | 3\nD | 4\nE | 5")).toBeNull();
    expect(validateUi("stat", "Label only")).toBeNull();
  });

  it("draws buttons, fields and tiles", () => {
    const choices = render(fence("choices", "Free\nPro"));
    expect(choices).toContain('class="ui-choice"');
    expect(choices).toContain(">Pro</button>");
    const form = render(fence("form", "budget | Budget | number\nflex | Flexible | yes/no"));
    expect(form).toContain('type="number"');
    expect(form).toContain('class="ui-toggle"');
    expect(form).toContain(">Send</button>");
    const stat = render(fence("stat", "Users | 12,400 | +8%\nChurn | 2.1% | -0.3pt"));
    expect(stat).toContain('class="ui-stat-delta up"');
    expect(stat).toContain('class="ui-stat-delta down"');
  });

  it("sends a form as one compact line", () => {
    const spec = validateUi("form", "# Trip\nbudget | Budget | number\nnote | Note") as FormSpec;
    expect(formReply(spec, { budget: " 500 ", note: "near a beach, quiet" })).toBe('Form "Trip": budget=500, note="near a beach, quiet"');
    expect(statMarkdown({ name: "stat", stats: [{ label: "Users", value: "12k", delta: "+8%" }] })).toBe("- Users: **12k** (+8%)");
  });

  it("sends a reply in the open thread, queueing it while a turn runs", () => {
    const send = vi.fn(async () => true);
    const enqueue = vi.fn();
    useStore.setState({ selectedThreadId: null, send, enqueue, running: {} });
    expect(sendUiReply("Pro")).toBe(false);
    useStore.setState({ selectedThreadId: "t1" });
    expect(sendUiReply("Pro")).toBe(true);
    expect(send).toHaveBeenCalledWith("Pro");
    useStore.setState({ running: { t1: true } });
    sendUiReply("Team");
    expect(enqueue).toHaveBeenCalledWith("t1", "Team");
    expect(sendUiReply("   ")).toBe(false);
  });
});

describe("bold-title lists as cards", () => {
  const initial = useStore.getState();
  afterEach(() => useStore.setState(initial, true));

  it("renders `**Title** — text` lists as cards only with Interactive answers on", async () => {
    const { boldLeadItems } = await import("../src/renderer/src/markdown");
    expect(boldLeadItems(["**One source of truth** — keep DESIGN.md", "**A skill for each job:** separate auditing"])).toEqual([
      { title: "One source of truth", text: "keep DESIGN.md" },
      { title: "A skill for each job", text: "separate auditing" },
    ]);
    expect(boldLeadItems(["**A** — x", "plain item"])).toBeNull();
    expect(boldLeadItems(["**A**", "**B**"])).toBeNull();
    const text = "1. **Penpot** — open-source design\n2. **Draftly**: rapid exploration";
    expect(render(text)).not.toContain("ui-cards");
    // Server rendering reads zustand's initial state (see genui-smart-table.test.tsx).
    const seed = useStore.getInitialState() as { settings: unknown };
    seed.settings = { uiBlocks: true };
    const html = render(text);
    seed.settings = null;
    expect(html).toContain('class="ui-block md-cards"');
    expect(html).toContain("1. Penpot");
    expect(html).toContain('class="ui-card-text">rapid exploration');
  });
});
