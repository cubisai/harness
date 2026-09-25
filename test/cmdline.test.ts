import { describe, expect, it } from "vitest";
import { joinCommandLine, splitCommandLine } from "../src/renderer/src/cmdline";

describe("splitCommandLine", () => {
  it("splits on spaces and keeps quoted words whole", () => {
    expect(splitCommandLine('  npx -y @scope/pkg  --root "/Users/me/My Code" \'it"s\' ""')).toEqual(["npx", "-y", "@scope/pkg", "--root", "/Users/me/My Code", 'it"s', ""]);
    expect(splitCommandLine("")).toEqual([]);
  });
  it("round-trips through joinCommandLine", () => {
    const words = ["uvx", "mcp-server", "--path", "C:\\Program Files\\x", ""];
    expect(splitCommandLine(joinCommandLine(words))).toEqual(words);
  });
});
