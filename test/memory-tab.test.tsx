import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryOverview } from "../src/shared/types";

const overview: MemoryOverview = {
  enabled: true,
  projectOn: true,
  dir: "/tmp/memory/projects/p1",
  index: { lines: 4, tokens: 30 },
  notes: [
    { file: "commit-style.md", name: "Commit Style", description: "Max 150 chars", type: "feedback" },
    { file: "deploy.md", name: "Deploy", description: "Run make deploy", type: "project" },
  ],
};

describe("MemoryTab", () => {
  afterEach(() => vi.unstubAllGlobals());

  // `renderToStaticMarkup` runs no effects, so the fetch never fires: the
  // overview arrives through the same `overview` prop the app leaves unset.
  // Server rendering reads zustand's initial state, so seed it directly.
  const render = async () => {
    vi.stubGlobal("window", { unskilled: {} });
    const { useStore } = await import("../src/renderer/src/store");
    const { MemoryTab } = await import("../src/renderer/src/components/MemoryTab");
    return { useStore, MemoryTab };
  };

  it("renders the notes, the index line and the global switch with a project", async () => {
    const { useStore, MemoryTab } = await render();
    const state = useStore.getInitialState();
    const saved = state.selectedProjectId;
    try {
      state.selectedProjectId = "p1";
      const html = renderToStaticMarkup(<MemoryTab overview={overview} />);
      expect(html).toContain("Commit Style");
      expect(html).toContain("Deploy");
      expect(html).toContain("index lines");
      expect(html).toContain("Shared memory");
    } finally {
      state.selectedProjectId = saved;
    }
  });

  it("asks for a project when none is selected", async () => {
    const { useStore, MemoryTab } = await render();
    const state = useStore.getInitialState();
    const saved = state.selectedProjectId;
    try {
      state.selectedProjectId = null;
      expect(renderToStaticMarkup(<MemoryTab overview={overview} />)).toContain("Pick a project");
    } finally {
      state.selectedProjectId = saved;
    }
  });
});
