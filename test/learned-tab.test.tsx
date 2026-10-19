import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearnOverview, Lesson, LessonVerification } from "../src/shared/learn";

const verification: LessonVerification = {
  model: "gpt-5-mini",
  agent: "codex",
  appVersion: "1.4.0",
  at: Date.UTC(2026, 9, 13),
  before: { passed: 0, of: 3 },
  after: { passed: 3, of: 3 },
  transfer: { held: 4, of: 4 },
};

function lesson(patch: Partial<Lesson>): Lesson {
  return {
    id: "l0",
    projectId: "p1",
    rule: "Run the checks before claiming a task is done.",
    why: "A turn said it was done while the check still failed.",
    scope: { paths: [], keywords: [] },
    status: "candidate",
    helpful: 0,
    harmful: 0,
    relevant: 0,
    tries: 0,
    pinned: false,
    caseId: null,
    provenance: { threadId: "t1", userSeq: 1, signals: [], agent: "codex", model: "gpt-5-mini" },
    verified: null,
    note: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const overview: LearnOverview = {
  enabled: true,
  background: { agent: "codex", model: "gpt-5-mini", label: "Codex · gpt-5-mini" },
  dailyTokens: 50_000,
  usedToday: 12_300,
  trend: [],
  lessons: [
    lesson({ id: "a1", status: "active", pinned: true, helpful: 3, harmful: 0, relevant: 5, verified: verification }),
    lesson({ id: "c1", status: "candidate", rule: "Check the flaky test before rerunning the suite.", note: "Waiting to be verified by a replay." }),
    lesson({ id: "r1", status: "retired", rule: "Always format with tabs.", note: "retired by you" }),
  ],
  cases: [
    { id: "case1", createdAt: 1, grader: "check command passes", heldOut: true, threadId: "t1", userSeq: 1 },
    { id: "case2", createdAt: 2, grader: "check command passes", heldOut: false, threadId: "t1", userSeq: 2 },
  ],
};

describe("LearnedTab", () => {
  afterEach(() => vi.unstubAllGlobals());

  // `renderToStaticMarkup` runs no effects, so the fetch never fires: the
  // overview arrives through the same `overview` prop the app leaves unset.
  // Server rendering reads zustand's initial state, so seed it directly.
  const render = async () => {
    vi.stubGlobal("window", { unskilled: {} });
    const { useStore } = await import("../src/renderer/src/store");
    const { LearnedTab, groupLessons, evidenceText, actionsFor, compact } = await import("../src/renderer/src/components/LearnedTab");
    return { useStore, LearnedTab, groupLessons, evidenceText, actionsFor, compact };
  };

  it("renders the status groups, the pinned marker and the header meta", async () => {
    const { useStore, LearnedTab } = await render();
    const state = useStore.getInitialState();
    const saved = state.selectedProjectId;
    try {
      state.selectedProjectId = "p1";
      const html = renderToStaticMarkup(<LearnedTab overview={overview} />);
      const at = (label: string) => html.indexOf(`learned-group">${label}<`);
      expect(at("Active")).toBeLessThan(at("Candidates"));
      expect(at("Candidates")).toBeLessThan(at("Retired"));
      expect(html).toContain("learned-pin");
      expect(html).toContain("helpful 3 · harmful 0 · sent 5");
      expect(html).toContain("Check the flaky test");
      expect(html).toContain("Codex · gpt-5-mini");
      expect(html).toContain("Today: 12.3k / 50k tokens");
      expect(html).toContain("2 captured cases (1 held out)");
    } finally {
      state.selectedProjectId = saved;
    }
  });

  it("hides dropped lessons", async () => {
    const { useStore, LearnedTab } = await render();
    const state = useStore.getInitialState();
    const saved = state.selectedProjectId;
    try {
      state.selectedProjectId = "p1";
      const html = renderToStaticMarkup(<LearnedTab overview={{ ...overview, lessons: [...overview.lessons, lesson({ id: "d1", status: "dropped", rule: "DROP_MARKER" })] }} />);
      expect(html).not.toContain("DROP_MARKER");
    } finally {
      state.selectedProjectId = saved;
    }
  });

  it("says self-improve is off while still listing lessons", async () => {
    const { useStore, LearnedTab } = await render();
    const state = useStore.getInitialState();
    const saved = state.selectedProjectId;
    try {
      state.selectedProjectId = "p1";
      const html = renderToStaticMarkup(<LearnedTab overview={{ ...overview, enabled: false }} />);
      expect(html).toContain("Off for this project.");
      // Its own switch, with Off pressed.
      expect(html).toContain('aria-label="Self-improve for this project"');
      expect(html).toMatch(/class="on" aria-pressed="true">Off</);
      expect(html).toContain("Check the flaky test");
    } finally {
      state.selectedProjectId = saved;
    }
  });

  it("shows On pressed and no off note when self-improve is on", async () => {
    const { useStore, LearnedTab } = await render();
    const state = useStore.getInitialState();
    const saved = state.selectedProjectId;
    try {
      state.selectedProjectId = "p1";
      const html = renderToStaticMarkup(<LearnedTab overview={{ ...overview, enabled: true }} />);
      expect(html).toMatch(/class="on" aria-pressed="true">On</);
      expect(html).not.toContain("Off for this project.");
    } finally {
      state.selectedProjectId = saved;
    }
  });

  it("asks for a project when none is selected", async () => {
    const { useStore, LearnedTab } = await render();
    const state = useStore.getInitialState();
    const saved = state.selectedProjectId;
    try {
      state.selectedProjectId = null;
      expect(renderToStaticMarkup(<LearnedTab overview={overview} />)).toContain("Open a project to see what it has learned.");
    } finally {
      state.selectedProjectId = saved;
    }
  });

  it("writes the evidence lines for a verification, and the not-verified line", async () => {
    const { evidenceText } = await render();
    expect(evidenceText(verification)).toEqual([
      "Verified on codex · gpt-5-mini (app 1.4.0), 2026-10-13",
      "Without it: passed 0/3 · With it: passed 3/3 · Transfer: held 4/4",
    ]);
    expect(evidenceText(null)).toEqual(["Not verified yet"]);
  });

  it("picks the actions that apply to each status", async () => {
    const { actionsFor } = await render();
    expect(actionsFor(lesson({ status: "candidate" }))).toEqual(["verify", "drop"]);
    expect(actionsFor(lesson({ status: "active", pinned: false }))).toEqual(["retire", "pin"]);
    expect(actionsFor(lesson({ status: "active", pinned: true }))).toEqual(["retire", "unpin"]);
    expect(actionsFor(lesson({ status: "retired" }))).toEqual(["undo"]);
    expect(actionsFor(lesson({ status: "dropped" }))).toEqual(["undo"]);
  });

  it("groups lessons pinned-first then newest, leaving dropped ones out", async () => {
    const { groupLessons } = await render();
    const groups = groupLessons([
      lesson({ id: "a-old", status: "active", pinned: false, createdAt: 100 }),
      lesson({ id: "a-pinned", status: "active", pinned: true, createdAt: 50 }),
      lesson({ id: "a-newest", status: "active", pinned: false, createdAt: 200 }),
      lesson({ id: "c1", status: "candidate", createdAt: 10 }),
      lesson({ id: "r1", status: "retired", createdAt: 20 }),
      lesson({ id: "d1", status: "dropped", createdAt: 30 }),
    ]);
    expect(groups.active.map((l) => l.id)).toEqual(["a-pinned", "a-newest", "a-old"]);
    expect(groups.candidates.map((l) => l.id)).toEqual(["c1"]);
    expect(groups.retired.map((l) => l.id)).toEqual(["r1"]);
  });

  it("compacts token counts", async () => {
    const { compact } = await render();
    expect(compact(950)).toBe("950");
    expect(compact(1000)).toBe("1k");
    expect(compact(12_300)).toBe("12.3k");
    expect(compact(50_000)).toBe("50k");
    expect(compact(1_200_000)).toBe("1.2M");
  });
});
