import { describe, expect, it } from "vitest";
import { parseBlocks, splitStreamingTail } from "../src/renderer/src/streaming";

describe("ui fences", () => {
  it("parses a ui:<name> fence into a ui block", () => {
    expect(parseBlocks('```ui:checklist\n{"items":[]}\n```')).toEqual([{ type: "ui", name: "checklist", body: '{"items":[]}' }]);
  });

  it("leaves a plain code fence as a code block", () => {
    expect(parseBlocks("```ts\nconst a = 1;\n```")).toEqual([{ type: "code", text: "const a = 1;", lang: "ts" }]);
  });

  it("treats languages that fail the ui name pattern as code", () => {
    expect(parseBlocks('```ui:\n{"items":[]}\n```')[0]).toEqual({ type: "code", text: '{"items":[]}', lang: "ui:" });
    expect(parseBlocks("```ui:9x\n{}\n```")[0]).toEqual({ type: "code", text: "{}", lang: "ui:9x" });
  });
});

describe("splitStreamingTail with a ui fence", () => {
  it("keeps an unterminated ui fence in the tail", () => {
    const { frozen, tail } = splitStreamingTail('intro\n\n```ui:timeline\n{"steps":');
    expect(frozen).toBe("intro\n\n");
    expect(tail.startsWith("```ui:timeline")).toBe(true);
  });
});
