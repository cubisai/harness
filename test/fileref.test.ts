import { describe, expect, it } from "vitest";
import { parseFileRef } from "../src/renderer/src/fileref";

describe("parseFileRef", () => {
  it("reads paths with and without a position", () => {
    expect(parseFileRef("src/routes/auth.ts")).toEqual({ path: "src/routes/auth.ts" });
    expect(parseFileRef("./src/auth.ts:42")).toEqual({ path: "src/auth.ts", line: 42 });
    expect(parseFileRef("src/auth.ts:42:7")).toEqual({ path: "src/auth.ts", line: 42, column: 7 });
    expect(parseFileRef("README.md#L10")).toEqual({ path: "README.md", line: 10 });
    expect(parseFileRef("package.json")).toEqual({ path: "package.json" });
    expect(parseFileRef("packages\\app\\main.rs")).toEqual({ path: "packages\\app\\main.rs" });
    expect(parseFileRef("/Users/me/app/src/a.ts:3")).toEqual({ path: "/Users/me/app/src/a.ts", line: 3 });
    expect(parseFileRef("C:\\code\\app\\a.ts")).toEqual({ path: "C:\\code\\app\\a.ts" });
    expect(parseFileRef("~/notes/todo.md")).toEqual({ path: "~/notes/todo.md" });
    expect(parseFileRef("lib/weird.xyz")).toEqual({ path: "lib/weird.xyz" });
    expect(parseFileRef(".env.local")).toEqual({ path: ".env.local" });
    expect(parseFileRef("@scope/pkg/index.d.ts")).toEqual({ path: "@scope/pkg/index.d.ts" });
  });

  it("leaves ordinary inline code alone", () => {
    for (const s of ["npm test", "https://x.dev/a.js", "e.g.", "1.2.3", "v1.2", "src/*.ts", "req.ip", "429", "trust proxy", "foo()", "a.b.c(d)"]) {
      expect(parseFileRef(s), s).toBeNull();
    }
  });
});
