/// <reference types="vite/client" />
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExpertDef } from "../src/shared/experts";

/** A def with the boring fields defaulted, so each test states only what it checks. */
const def = (partial: Partial<ExpertDef> & Pick<ExpertDef, "id" | "name">): ExpertDef => ({
  kind: "agent",
  profession: "",
  persona: "",
  category: "General",
  avatarText: partial.name.slice(0, 2).toUpperCase(),
  description: "",
  tags: [],
  quickPrompts: [],
  prompt: "You are helpful.",
  skills: [],
  source: "builtin",
  version: "1.0.0",
  ...partial,
});

const analyst = def({
  id: "data-analyst",
  name: "Data Analyst",
  profession: "Senior Data Analyst",
  persona: "Daniel",
  description: "Turns complex data into clear answers.",
  quickPrompts: ["Write SQL for weekly actives", "Summarize this CSV"],
});
const team = def({
  id: "software-delivery-team",
  name: "Software Delivery Team",
  kind: "team",
  profession: "Engineering Lead",
  persona: "Dana",
  description: "Designs, builds and reviews the change.",
  quickPrompts: ["Design and build a rate limiter"],
  members: [
    { id: "architect", name: "Software Architect", profession: "Software Architect", description: "Designs the change.", prompt: "", skills: [] },
    { id: "reviewer", name: "Code Reviewer", profession: "Code Reviewer", description: "Reviews it.", prompt: "", skills: [] },
    { id: "tester", name: "QA Engineer", profession: "QA Engineer", description: "Tests it.", prompt: "", skills: [] },
  ],
});
const catalog: ExpertDef[] = [analyst, team];

/** Stub the bridge, then import the store and the components (expert-center.test.tsx's pattern). */
const load = async () => {
  vi.stubGlobal("window", {
    unskilled: {
      listExperts: vi.fn(async () => catalog),
      getExpert: vi.fn(async (id: string) => catalog.find((e) => e.id === id) ?? null),
    },
  });
  const store = await import("../src/renderer/src/store");
  const chip = await import("../src/renderer/src/components/experts/ExpertChip");
  return { useStore: store.useStore, ...chip };
};

type El = { type?: unknown; props?: Record<string, unknown> };

/** React SSR separates adjacent text nodes with a comment; drop them before matching prose. */
const strip = (html: string): string => html.replace(/<!-- -->/g, "");

/** Every element in a directly-called component's tree that matches. */
const findAll = (root: unknown, match: (el: El) => boolean): El[] => {
  const found: El[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const el = node as El;
    if (!el.props) return;
    if (match(el)) found.push(el);
    visit(el.props.children);
  };
  visit(root);
  return found;
};

describe("ExpertChip", () => {
  afterEach(() => vi.unstubAllGlobals());

  // `renderToStaticMarkup` reads zustand's initial state (no effects run), so seed it directly.
  const seed = (
    useStore: { getInitialState(): { experts: ExpertDef[] | null; selectedProjectId: string | null } },
    experts: ExpertDef[] | null,
  ) => {
    const state = useStore.getInitialState();
    const saved = { experts: state.experts, selectedProjectId: state.selectedProjectId };
    state.experts = experts;
    state.selectedProjectId = "p1";
    return () => {
      state.experts = saved.experts;
      state.selectedProjectId = saved.selectedProjectId;
    };
  };

  it("shows the expert's avatar and name for a known id, and nothing for an unknown one", async () => {
    const { ExpertChip, useStore } = await load();
    const restore = seed(useStore, catalog);
    try {
      const html = strip(renderToStaticMarkup(<ExpertChip expertId="data-analyst" />));
      expect(html).toContain('aria-label="Expert: Data Analyst"');
      expect(html).toContain("assets/experts/data-analyst.svg");
      expect(html).toContain("Data Analyst");
      expect(renderToStaticMarkup(<ExpertChip expertId="no-such-expert" />)).toBe("");
    } finally {
      restore();
    }
  });

  it("marks a team chip with a muted Team suffix", async () => {
    const { ExpertChip, useStore } = await load();
    const restore = seed(useStore, catalog);
    try {
      const html = strip(renderToStaticMarkup(<ExpertChip expertId="software-delivery-team" />));
      expect(html).toContain("Software Delivery Team");
      expect(html).toContain('class="expert-chip-team"');
      expect(html).toContain("· Team");
    } finally {
      restore();
    }
  });

  it("opens the expert's detail dialog from the chip", async () => {
    const { ExpertChipView } = await load();
    const props = { def: analyst, used: 0, canSummon: true, onClose: () => {}, onSummon: () => {}, onSummonPrompt: () => {} };

    let open = false;
    const onOpen = () => {
      open = true;
    };
    expect(renderToStaticMarkup(<ExpertChipView {...props} open={false} onOpen={onOpen} />)).not.toContain('role="dialog"');

    const chip = findAll(ExpertChipView({ ...props, open: false, onOpen }), (el) => el.props?.className === "chip-button expert-chip")[0]!;
    (chip.props!.onClick as () => void)();
    expect(open).toBe(true);

    expect(renderToStaticMarkup(<ExpertChipView {...props} open onOpen={onOpen} />)).toContain('role="dialog"');
  });
});

describe("ExpertIntro", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the description and quick prompts", async () => {
    const { ExpertIntro, useStore } = await load();
    const state = useStore.getInitialState();
    const saved = state.experts;
    try {
      state.experts = catalog;
      const html = strip(renderToStaticMarkup(<ExpertIntro expertId="data-analyst" />));
      expect(html).toContain("Turns complex data into clear answers.");
      expect(html).toContain("Senior Data Analyst");
      expect(html).toContain("Try asking");
      expect(html).toContain("Write SQL for weekly actives");
      expect(html).toContain("Answers come from an AI playing this role");
    } finally {
      state.experts = saved;
    }
  });

  it("a quick prompt pre-fills the composer and never summons", async () => {
    const { ExpertIntroView, useStore } = await load();
    const setComposerDraft = vi.fn();
    const summonExpert = vi.fn(async () => null);
    const saved = { setComposerDraft: useStore.getState().setComposerDraft, summonExpert: useStore.getState().summonExpert };
    useStore.setState({ setComposerDraft, summonExpert });
    try {
      const tree = ExpertIntroView({ def: analyst });
      const prompt = findAll(tree, (el) => el.props?.className === "expert-intro-prompt")[0]!;
      (prompt.props!.onClick as () => void)();
      expect(setComposerDraft).toHaveBeenCalledWith("Write SQL for weekly actives");
      expect(summonExpert).not.toHaveBeenCalled();
    } finally {
      useStore.setState(saved);
    }
  });

  it("a team intro counts its members and explains the lead's role", async () => {
    const { ExpertIntro, useStore } = await load();
    const state = useStore.getInitialState();
    const saved = state.experts;
    try {
      state.experts = catalog;
      const html = strip(renderToStaticMarkup(<ExpertIntro expertId="software-delivery-team" />));
      expect(html).toContain("3 team members");
      expect(html).toContain("The lead hands parts of the task to members and combines their results.");
    } finally {
      state.experts = saved;
    }
  });
});

describe("ExpertAvatar", () => {
  it("shows the bundled portrait for a bundled expert or team member, else one generated from the id", async () => {
    const { ExpertAvatar, expertAvatarUrl, generatedAvatarUrl, initials, memberAvatarId } = await import("../src/renderer/src/components/experts/ExpertAvatar");
    expect(expertAvatarUrl("code-reviewer")).toContain("code-reviewer.svg");
    expect(expertAvatarUrl(memberAvatarId("software-delivery-team", "tester"))).toContain("software-delivery-team--tester.svg");
    expect(expertAvatarUrl("imported-thing")).toBeUndefined();
    const url = generatedAvatarUrl("imported-thing");
    expect(url).toMatch(/^data:image\/svg\+xml/);
    expect(generatedAvatarUrl("imported-thing")).toBe(url);
    expect(generatedAvatarUrl("another-import")).not.toBe(url);
    const imported = renderToStaticMarkup(<ExpertAvatar id="imported-thing" text="IT" className="xs-avatar" />);
    expect(imported).toContain('<img class="xs-avatar expert-avatar-img"');
    expect(imported).not.toContain(">IT<");
    expect(initials("Research Planner & Editor")).toBe("RP");
  });
});

describe("ExpertChip remove", () => {
  it("shows a × only when the view gets onRemove, and calls it", async () => {
    const { ExpertChipView } = await load();
    const props = { def: analyst, used: 0, canSummon: true, open: false, onOpen: () => {}, onClose: () => {}, onSummon: () => {}, onSummonPrompt: () => {} };
    expect(renderToStaticMarkup(<ExpertChipView {...props} />)).not.toContain("expert-chip-remove");

    let removed = false;
    const tree = ExpertChipView({ ...props, onRemove: () => (removed = true) });
    const x = findAll(tree, (el) => el.props?.className === "icon-button expert-chip-remove")[0]!;
    expect(x.props!["aria-label"]).toBe("Remove Data Analyst");
    (x.props!.onClick as () => void)();
    expect(removed).toBe(true);
  });
});
