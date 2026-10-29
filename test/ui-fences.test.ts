import { describe, expect, it } from "vitest";
import { summarizeUiFences } from "../src/shared/ui-fences";

const fence = (name: string, body: string): string => `\`\`\`ui:${name}\n${body}\n\`\`\``;

describe("summarizeUiFences", () => {
  it("replaces a JSON block with its name, title and item count", () => {
    const text = `Here:\n\n${fence("checklist", JSON.stringify({ title: "Ship it", items: [{ text: "a" }, { text: "b" }] }))}\n\nDone?`;
    expect(summarizeUiFences(text)).toBe('Here:\n\n[ui:checklist "Ship it", 2 items]\n\nDone?');
  });

  it("counts line-form rows, skipping meta lines and a compare header", () => {
    expect(summarizeUiFences(fence("chart", "# Spend\nunit: $\nRent | 1200\nFood | 400"))).toBe('[ui:chart "Spend", 2 items]');
    expect(summarizeUiFences(fence("compare", "Plan | Price\n--- | ---\n*Pro | 20\nFree | 0"))).toBe("[ui:compare 2 items]");
    expect(summarizeUiFences(fence("calculator", "a | A | 2\n= a*2"))).toBe("[ui:calculator 1 item]");
  });

  it("summarizes every block and leaves other fences and text alone", () => {
    const text = [fence("timeline", "10:00 | Start"), "```ts\nconst ui = 1;\n```", fence("chart", "{bad json")].join("\n");
    expect(summarizeUiFences(text)).toBe(["[ui:timeline 1 item]", "```ts\nconst ui = 1;\n```", "[ui:chart 0 items]"].join("\n"));
    expect(summarizeUiFences("no blocks here")).toBe("no blocks here");
  });

  it("leaves an unterminated fence as written", () => {
    const text = "```ui:checklist\n[x] a";
    expect(summarizeUiFences(text)).toBe(text);
  });
});
