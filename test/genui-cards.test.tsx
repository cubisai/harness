import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/renderer/src/markdown";
import { validateUi } from "../src/renderer/src/genui/validate";
import { cardsMarkdown, leadKind } from "../src/renderer/src/genui/components/Cards";
import type { CardsSpec } from "../src/renderer/src/genui/types";

/** Markup of one reply through the renderer under test. */
const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);
const fence = (name: string, body: unknown): string => `\`\`\`ui:${name}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\``;

const SPEC: CardsSpec = {
  name: "cards",
  title: "Plan",
  items: [
    { lead: "check", title: "One source of truth", text: "Keep DESIGN.md as the entry" },
    { title: "Penpot", text: "Open-source design", link: "https://penpot.app" },
  ],
};

describe("cards block", () => {
  it("classifies a row's lead as an icon, an image or nothing", () => {
    expect(leadKind("check").kind).toBe("icon");
    expect(leadKind("Checks").kind).toBe("icon");
    expect(leadKind("https://x.com/a.png")).toEqual({ kind: "image", src: "https://x.com/a.png" });
    expect(leadKind("./shots/a.PNG")).toEqual({ kind: "image", src: "./shots/a.PNG" });
    expect(leadKind("nonsense-word").kind).toBe("none");
    expect(leadKind(undefined).kind).toBe("none");
  });

  it("reads the compact line form: lead, title, text and link", () => {
    const body = ["# Plan", "check | One source of truth | Keep DESIGN.md as the entry", "| Penpot | Open-source design | https://penpot.app", "Rocket"].join("\n");
    expect(validateUi("cards", body)).toEqual({
      name: "cards",
      title: "Plan",
      items: [
        { lead: "check", title: "One source of truth", text: "Keep DESIGN.md as the entry" },
        { title: "Penpot", text: "Open-source design", link: "https://penpot.app" },
        { title: "Rocket" },
      ],
    });
  });

  it("drops a non-https link and refuses more than 12 rows", () => {
    expect(validateUi("cards", '{"items":[{"title":"A","link":"http://insecure.example"}]}')).toEqual({ name: "cards", items: [{ title: "A" }] });
    const rows = Array.from({ length: 13 }, (_, i) => `Row ${i + 1}`).join("\n");
    expect(validateUi("cards", rows)).toBeNull();
  });

  it("draws a fence as rows: icon lead, link host, no <img> before the async thumbnail", () => {
    const html = render(fence("cards", SPEC));
    expect(html).toContain('class="ui-cards"');
    expect(html).toContain("Plan");
    expect(html).toContain("penpot.app ↗");
    expect(html).toContain("<svg");
    expect(html).toContain("lucide-circle-check");
    expect(html).not.toContain("<img");
  });

  it("builds cards Markdown, with the link host and without empty parts", () => {
    expect(cardsMarkdown(SPEC)).toBe(
      "**Plan**\n\n- **One source of truth** — Keep DESIGN.md as the entry\n- **Penpot** — Open-source design ([penpot.app](https://penpot.app))",
    );
  });
});
