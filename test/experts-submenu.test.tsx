import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExpertDef } from "../src/shared/experts";
import { Composer } from "../src/renderer/src/components/Composer";
import { ExpertsSubmenu, browseAllExperts, chooseExpert, filterExperts, recentExperts } from "../src/renderer/src/components/ExpertsSubmenu";
import { useStore } from "../src/renderer/src/store";

const mk = (id: string, name: string, extra: Partial<ExpertDef> = {}): ExpertDef => ({
  id,
  kind: "agent",
  name,
  profession: `${name} profession`,
  persona: `${name} persona`,
  category: "General",
  avatarText: id.slice(0, 2).toUpperCase(),
  description: `${name} description`,
  tags: [],
  quickPrompts: [],
  prompt: `${name} prompt`,
  skills: [],
  source: "builtin",
  version: "1.0.0",
  ...extra,
});

/** Six experts, so the recents list (five max) has one to drop. */
const CATALOGUE = [mk("e1", "Alpha"), mk("e2", "Bravo"), mk("e3", "Charlie"), mk("e4", "Delta"), mk("e5", "Echo"), mk("e6", "Foxtrot")];
const FIVE = CATALOGUE.slice(0, 5);

/** A fake localStorage, since the node test environment has none. */
function fakeStorage(seed: Record<string, string> = {}): void {
  const map = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) });
}

/** Server rendering reads zustand's initial state; seed it directly, then restore. */
function withStore(experts: ExpertDef[] | null, projectId: string | null, fn: () => void): void {
  const state = useStore.getInitialState();
  const savedExperts = state.experts;
  const savedProject = state.selectedProjectId;
  try {
    state.experts = experts;
    state.selectedProjectId = projectId;
    fn();
  } finally {
    state.experts = savedExperts;
    state.selectedProjectId = savedProject;
  }
}

describe("ExpertsSubmenu", () => {
  beforeEach(() => {
    // Composer's import graph reads window; server rendering runs no effects, so a null-returning stub is enough.
    vi.stubGlobal("window", { unskilled: new Proxy({}, { get: () => async () => null }) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useStore.setState({ libraryTab: null });
  });

  it("lists Experts in the composer's + menu", () => {
    const html = renderToStaticMarkup(<Composer threadId="t" />);
    expect(html).toContain('aria-label="Experts"');
  });

  it("shows recent experts from the store when no query is typed", () => {
    withStore(FIVE, "p", () => {
      const html = renderToStaticMarkup(<ExpertsSubmenu close={() => {}} />);
      for (const e of FIVE) expect(html).toContain(`>${e.name}</span>`);
    });
  });

  it("moves an expert read from localStorage to the front of the recents", () => {
    fakeStorage({ "cubiq.expertUsage": JSON.stringify({ e6: 1 }) });
    withStore(CATALOGUE, "p", () => {
      const html = renderToStaticMarkup(<ExpertsSubmenu close={() => {}} />);
      expect(html).toContain("Foxtrot");
      // Only five show, so the least recent drops out.
      expect(html).not.toContain("Echo");
      expect(html.indexOf("Foxtrot")).toBeLessThan(html.indexOf("Alpha"));
    });
  });

  it("disables the rows until a project is open", () => {
    withStore(FIVE, null, () => {
      const html = renderToStaticMarkup(<ExpertsSubmenu close={() => {}} />);
      expect(html).toContain('title="Open a project first"');
      expect(html).toMatch(/<button class="xs-row"[^>]*disabled/);
    });
  });

  it("filters experts by name, profession or tag", () => {
    const experts = [...FIVE, mk("code-review", "Code Review Expert", { profession: "Reviewer", tags: ["Quality Gate"] })];
    expect(filterExperts(experts, "code")).toEqual([experts[5]]);
    expect(filterExperts(experts, "quality")).toEqual([experts[5]]);
    expect(filterExperts(experts, "reviewer")).toEqual([experts[5]]);
    expect(filterExperts(experts, "  ")).toEqual(experts);
  });

  it("ranks recents by summons and falls back to catalogue order", () => {
    expect(recentExperts(CATALOGUE, { e6: 2 }).map((e) => e.id)).toEqual(["e6", "e1", "e2", "e3", "e4"]);
    expect(recentExperts(CATALOGUE, {}).map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  it("summons the picked expert with its id", () => {
    const close = vi.fn<() => void>();
    const summon = vi.fn<(id: string, prompt?: string) => Promise<string | null>>(async () => null);
    const original = useStore.getInitialState().summonExpert;
    useStore.setState({ summonExpert: summon });
    try {
      chooseExpert("code-review", close);
      expect(summon).toHaveBeenCalledWith("code-review");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      useStore.setState({ summonExpert: original });
    }
  });

  it("Browse all experts opens the Library on its Experts tab", () => {
    const close = vi.fn<() => void>();
    browseAllExperts(close);
    expect(close).toHaveBeenCalledOnce();
    expect(useStore.getState().libraryTab).toBe("experts");
  });
});
