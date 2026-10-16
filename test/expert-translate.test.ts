import { describe, expect, it } from "vitest";
import { makeTranslate, TRANSLATE_SYSTEM } from "../src/main/experts/translate";

describe("makeTranslate", () => {
  const items = [
    { path: "expert.md", text: "\u7814\u7a76" },
    { path: "members/a.md", text: "\u6838\u9a8c" },
  ];

  it("sends the items as JSON with the translation instructions and returns the array", async () => {
    const seen: { system: string; user: string }[] = [];
    const translate = makeTranslate(async (system, user) => {
      seen.push({ system, user });
      return '```json\n["Research", "Verify"]\n```';
    });
    expect(await translate(items)).toEqual(["Research", "Verify"]);
    expect(seen[0]!.system).toBe(TRANSLATE_SYSTEM);
    expect(JSON.parse(seen[0]!.user)).toEqual(items);
  });

  it("keeps the originals on a wrong-length reply, a non-array or a failed call", async () => {
    expect(await makeTranslate(async () => '["only one"]')(items)).toEqual(["\u7814\u7a76", "\u6838\u9a8c"]);
    expect(await makeTranslate(async () => "sorry")(items)).toEqual(["\u7814\u7a76", "\u6838\u9a8c"]);
    expect(
      await makeTranslate(async () => {
        throw new Error("offline");
      })(items),
    ).toEqual(["\u7814\u7a76", "\u6838\u9a8c"]);
  });
});
