import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExpertDef } from "../src/shared/experts";
import type { SkillEntry, Thread } from "../src/shared/types";
import { Composer } from "../src/renderer/src/components/Composer";
import { ExpertsSubmenu, browseAllExperts, chooseExpert, filterExperts, pickMode, recentExperts } from "../src/renderer/src/components/ExpertsSubmenu";
import { filterSkills } from "../src/renderer/src/components/SkillsSubmenu";
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

const sk = (name: string, extra: Partial<SkillEntry> = {}): SkillEntry => ({
  name,
  description: `${name} description`,
  invocation: "user",
  calls: [],
  files: [],
  sha256: "x",
  ...extra,
});

const THREAD = { id: "t1", projectId: "p", kind: "chat" } as unknown as Thread;

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

  it("lists Skills in the composer's + menu", () => {
    const html = renderToStaticMarkup(<Composer threadId="t" />);
    expect(html).toContain('aria-label="Skills"');
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

  it("pickMode starts a new thread when none is open", () => {
    expect(pickMode({ thread: null, messages: 0, running: false, def: { id: "e1" } })).toBe("new");
  });

  it("pickMode sets a chat expert on an empty chat thread", () => {
    expect(pickMode({ thread: { kind: "chat" }, messages: 0, running: false, def: { id: "e1" } })).toBe("here");
  });

  it("pickMode leaves an empty thread that already has this expert alone", () => {
    expect(pickMode({ thread: { kind: "chat", expertId: "e1" }, messages: 0, running: false, def: { id: "e1" } })).toBe("same");
  });

  it("pickMode starts a new thread for a design expert on a chat thread", () => {
    expect(pickMode({ thread: { kind: "chat" }, messages: 0, running: false, def: { id: "d1", threadKind: "design" } })).toBe("new");
  });

  it("pickMode confirms a new thread when the thread has messages", () => {
    expect(pickMode({ thread: { kind: "chat" }, messages: 2, running: false, def: { id: "e1" } })).toBe("confirm");
  });

  it("pickMode confirms a new thread when the empty thread is running", () => {
    expect(pickMode({ thread: { kind: "chat" }, messages: 0, running: true, def: { id: "e1" } })).toBe("confirm");
  });

  it("sets the expert on an empty selected thread without summoning", () => {
    const setExpert = vi.fn<(threadId: string, id: string) => Promise<void>>(async () => {});
    const summon = vi.fn<(id: string, prompt?: string) => Promise<string | null>>(async () => null);
    const saved = useStore.getInitialState();
    useStore.setState({
      threads: { p: [THREAD] },
      events: { t1: [] },
      running: {},
      selectedThreadId: "t1",
      experts: [mk("e1", "Alpha")],
      setThreadExpert: setExpert,
      summonExpert: summon,
    });
    try {
      const close = vi.fn<() => void>();
      expect(chooseExpert("e1", close)).toBe("here");
      expect(setExpert).toHaveBeenCalledWith("t1", "e1");
      expect(summon).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      useStore.setState(saved);
    }
  });

  it("filterSkills drops skills that aren't user-invocable", () => {
    const all = [sk("tdd"), sk("hidden", { userInvocable: false })];
    expect(filterSkills(all, "", false).map((s) => s.name)).toEqual(["tdd"]);
  });

  it("filterSkills hides design-only skills outside a design thread", () => {
    const all = [sk("tdd"), sk("prototype", { mode: "design" })];
    expect(filterSkills(all, "", false).map((s) => s.name)).toEqual(["tdd"]);
    expect(filterSkills(all, "", true).map((s) => s.name)).toEqual(["tdd", "prototype"]);
  });

  it("filterSkills matches by description and ranks name prefixes first", () => {
    const all = [sk("code", { description: "review the code" }), sk("review", { description: "read a diff" })];
    expect(filterSkills(all, "review", false).map((s) => s.name)).toEqual(["review", "code"]);
  });
});
