import { describe, expect, it } from "vitest";
import { toTsDeclaration } from "../src/main/harness/tools/ts-decl";

describe("toTsDeclaration", () => {
  it("marks properties optional unless required, with their descriptions", () => {
    const decl = toTsDeclaration("read_file", "Reads a file.\nMore detail is dropped.", {
      type: "object",
      properties: {
        path: { type: "string", description: "Where to read." },
        limit: { type: "integer" },
      },
      required: ["path"],
    });
    expect(decl).toBe(
      [
        "/** Reads a file. */",
        "declare function read_file(args: {",
        "  /** Where to read. */ path: string;",
        "  limit?: number;",
        "}): Promise<string>;",
      ].join("\n"),
    );
  });

  it("renders an enum as a union of JSON literals", () => {
    const decl = toTsDeclaration("pick", "Picks one.", {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "slow"] },
        level: { enum: [1, 2] },
      },
      required: ["mode", "level"],
    });
    expect(decl).toContain('mode: "fast" | "slow";');
    expect(decl).toContain("level: 1 | 2;");
  });

  it("renders an array of objects inline", () => {
    const decl = toTsDeclaration("rows", "Rows.", {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: { type: "object", properties: { id: { type: "integer" }, tag: { type: "string" } }, required: ["id"] },
        },
      },
      required: ["rows"],
    });
    expect(decl).toBe(
      [
        "/** Rows. */",
        "declare function rows(args: {",
        "  rows: {",
        "    id: number;",
        "    tag?: string;",
        "  }[];",
        "}): Promise<string>;",
      ].join("\n"),
    );
  });

  it("renders nested objects recursively", () => {
    const decl = toTsDeclaration("nested", "Nested.", {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { kind: { type: "string", description: "What to keep." } },
          required: ["kind"],
        },
      },
    });
    expect(decl).toBe(
      [
        "/** Nested. */",
        "declare function nested(args: {",
        "  filter?: {",
        "    /** What to keep. */ kind: string;",
        "  };",
        "}): Promise<string>;",
      ].join("\n"),
    );
  });

  it("unions anyOf and oneOf members", () => {
    const anyOf = toTsDeclaration("any", "Any.", {
      type: "object",
      properties: { value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] } },
      required: ["value"],
    });
    expect(anyOf).toContain("value: string | number | null;");
    const oneOf = toTsDeclaration("one", "One.", {
      type: "object",
      properties: { value: { oneOf: [{ type: "boolean" }, { type: "array", items: { type: "string" } }] } },
      required: ["value"],
    });
    expect(oneOf).toContain("value: boolean | string[];");
  });

  it("quotes keys that are not identifiers", () => {
    const decl = toTsDeclaration("quoted", "Quoted.", {
      type: "object",
      properties: { "x-y": { type: "boolean" } },
      required: ["x-y"],
    });
    expect(decl).toContain('"x-y": boolean;');
  });

  it("renders an empty schema with no args", () => {
    const decl = toTsDeclaration("noop", "Does nothing.", { type: "object", properties: {} });
    expect(decl).toBe(["/** Does nothing. */", "declare function noop(args?: Record<string, never>): Promise<string>;"].join("\n"));
    expect(toTsDeclaration("noop", "", null)).toContain("declare function noop(args?: Record<string, never>): Promise<string>;");
  });
});
