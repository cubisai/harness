import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ToolRow } from "../src/renderer/src/components/ThreadView";

const tool = { kind: "tool-use" as const, toolUseId: "t1", name: "Bash", summary: "npm test", payload: { command: "npm test" } };
const result = { kind: "tool-result" as const, toolUseId: "t1", isError: false, summary: "passed", payload: "SECRET-OUTPUT 3 passed" };

describe("tool disclosure", () => {
  it("keeps the body out of the markup while closed, and shows it when open", () => {
    const closed = renderToStaticMarkup(<ToolRow tool={tool} result={result} running={false} open={false} onToggle={() => {}} />);
    expect(closed).toContain("<details");
    expect(closed).not.toContain(" name=");
    expect(closed).not.toContain("SECRET-OUTPUT");

    const opened = renderToStaticMarkup(<ToolRow tool={tool} result={result} running={false} open onToggle={() => {}} />);
    expect(opened).toContain("SECRET-OUTPUT");
    expect(opened).toContain("Output");
  });

  it("renders an offloaded stub preview and its byte count", () => {
    const stub = { kind: "tool-use" as const, toolUseId: "t2", name: "Bash", summary: "cat big.log", payload: { blobRef: "abc", bytes: 100000, truncated: true, preview: "head of output" } };
    const html = renderToStaticMarkup(<ToolRow tool={stub} running={false} open onToggle={() => {}} />);
    expect(html).toContain("head of output");
    expect(html).toContain("100000 bytes");
  });
});

describe("disclosure store", () => {
  it("keys open state by thread and never persists it", async () => {
    const updateSettings = vi.fn();
    vi.stubGlobal("window", { unskilled: { updateSettings } });
    const { useStore } = await import("../src/renderer/src/store");

    useStore.getState().setDisclosure("thread-a", "t1", true);
    const disclosures = useStore.getState().disclosures;
    expect(disclosures["thread-a"]?.t1).toBe(true);
    expect(disclosures["thread-b"]).toBeUndefined();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});