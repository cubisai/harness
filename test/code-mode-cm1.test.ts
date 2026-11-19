// CM1 regressions: a "not a function" error names the script's real catalog
// (native edits and shell included), and the MCP server's read-only scripts skip
// search_tools because call_mcp_tool is never there to use its results.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessTool } from "../src/main/agents/types";
import { createCodeServer } from "../src/main/code-mode";
import type { LoopTool } from "../src/main/harness/loop";
import { createCodeTool, type CodeToolOptions } from "../src/main/harness/tools/code";
import { createCodeBroker } from "../src/main/harness/tools/code-broker";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "code-cm1-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tool = (name: string, over: Partial<LoopTool> = {}): LoopTool => ({
  definition: { name, description: name, parameters: { type: "object", properties: {} } },
  displayName: name,
  access: "read",
  summarize: () => name,
  run: async () => ({ text: `${name} ok` }),
  ...over,
});

const appTool = (name: string, over: Partial<HarnessTool> = {}): HarnessTool => ({
  name,
  description: name,
  input: {},
  autoAllow: true,
  effect: "read",
  run: async () => ({ text: name }),
  ...over,
});

function codeTool(tools: LoopTool[], broker: CodeToolOptions["broker"]) {
  return createCodeTool({ tools: () => tools, broker, outputDir: tmp() });
}
const run = (t: LoopTool, code: string) => t.run({ code }, { id: "c1", signal: new AbortController().signal, onOutput: () => {} });

describe("run_code's not-a-function explanation (CM1)", () => {
  it("names the edit and shell tools a native catalog has, without the read-only note", async () => {
    const tools = [tool("read"), tool("edit", { access: "edit" }), tool("bash", { access: "shell" })];
    const r = await run(codeTool(tools, createCodeBroker({ tools: () => tools, emit: () => {}, outputDir: tmp() })), "await tools.nope();");
    expect(r.text).toContain("A script's tools are:");
    expect(r.text).toContain("edit");
    expect(r.text).not.toContain("not available in a script");
  });

  it("keeps the read-only note when the catalog only reads", async () => {
    const tools = [tool("read"), tool("glob"), tool("grep")];
    const r = await run(codeTool(tools, createCodeBroker({ tools: () => tools, emit: () => {}, outputDir: tmp() })), "await tools.nope();");
    expect(r.text).toContain("A script's tools are:");
    expect(r.text).toContain("not available in a script");
  });
});

describe("createCodeServer's script catalog (CM1)", () => {
  const setup = () => {
    const dir = tmp();
    return createCodeServer({
      cwdOf: () => dir,
      projectOf: () => undefined,
      appTools: () => [
        appTool("search_tools", { effect: "read", autoAllow: true }),
        appTool("call_mcp_tool", { effect: "mutate", autoAllow: false }),
        appTool("design_read_x", { effect: "read", autoAllow: true }),
      ],
      parentOf: () => "parent-1",
      emit: () => {},
      outputDir: tmp(),
      guardScript: "builtin",
      parentWaitMs: 0,
    });
  };

  const runServer = (codes: ReturnType<typeof createCodeServer>, code: string) => codes.tool("t").run({ code } as never, undefined);

  it("skips search_tools and call_mcp_tool, keeping the read-only app tool", async () => {
    const r = await runServer(setup(), "return ALL_TOOLS");
    expect(r.text).toContain("design_read_x");
    expect(r.text).not.toContain("search_tools");
    expect(r.text).not.toContain("call_mcp_tool");
  });
});
