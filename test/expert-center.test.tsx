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

const dataAnalyst = def({
  id: "data-analyst",
  name: "Data Analyst",
  profession: "Senior Data Analyst",
  persona: "Daniel",
  category: "Data & AI",
  tags: ["analytics", "sql"],
  quickPrompts: ["Write SQL for weekly actives", "Summarize this CSV"],
});
const importedAgent = def({ id: "imported-agent", name: "Imported Agent", profession: "Custom Expert", persona: "Ivy", category: "Engineering", source: "imported" });
const frontendDev = def({
  id: "frontend-developer",
  name: "Frontend Developer",
  profession: "Senior Frontend Engineer",
  persona: "Fran",
  category: "Engineering",
  tags: ["react", "a11y"],
  quickPrompts: ["Build a pricing table"],
});
const copywriter = def({ id: "copywriter", name: "Copywriter", profession: "Senior Copywriter", persona: "Cleo", category: "Content & Creative", tags: ["copy"] });
const team = def({
  id: "software-delivery-team",
  name: "Software Delivery Team",
  kind: "team",
  profession: "Engineering Lead",
  persona: "Dana",
  category: "Engineering",
  tags: ["engineering", "delivery"],
  quickPrompts: ["Design and build a rate limiter"],
  source: "imported",
  members: [
    { id: "architect", name: "Architect", profession: "Software Architect", description: "Designs the change.", prompt: "", skills: [] },
    { id: "reviewer", name: "Reviewer", profession: "Code Reviewer", description: "Reviews it.", prompt: "", skills: [] },
  ],
});
const catalog: ExpertDef[] = [dataAnalyst, importedAgent, frontendDev, copywriter, team];

const base = { query: "", kind: "agent" as const, category: "All", sort: "recommended" as const, myExperts: false, usage: {} as Record<string, number> };

/** Stub the bridge, then import the store and the components (about.test.tsx's pattern). */
const load = async () => {
  vi.stubGlobal("window", {
    unskilled: {
      listExperts: vi.fn(async () => catalog),
      getExpert: vi.fn(async (id: string) => catalog.find((e) => e.id === id) ?? null),
    },
  });
  const store = await import("../src/renderer/src/store");
  const center = await import("../src/renderer/src/components/experts/ExpertCenter");
  const detail = await import("../src/renderer/src/components/experts/ExpertDetail");
  return { useStore: store.useStore, ...center, ...detail };
};

type El = { type?: unknown; props?: Record<string, unknown> };

const text = (node: unknown): string => {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) return text((node as El).props?.children);
  return "";
};

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

/** React SSR separates adjacent text nodes with a comment; drop them before matching prose. */
const strip = (html: string): string => html.replace(/<!-- -->/g, "");

describe("catalogue filtering", () => {
  it("filters by name, profession and tag, case-insensitively", async () => {
    const { filterDefs } = await load();
    expect(filterDefs(catalog, { ...base, query: "analyst" }).map((d) => d.id)).toEqual(["data-analyst"]);
    expect(filterDefs(catalog, { ...base, query: "senior frontend" }).map((d) => d.id)).toEqual(["frontend-developer"]);
    expect(filterDefs(catalog, { ...base, query: "SQL" }).map((d) => d.id)).toEqual(["data-analyst"]);
    expect(filterDefs(catalog, { ...base, query: "nothing here" })).toEqual([]);
  });

  it("shows experts or teams, never both", async () => {
    const { filterDefs } = await load();
    expect(filterDefs(catalog, { ...base, kind: "agent" }).map((d) => d.id)).toEqual(["data-analyst", "imported-agent", "frontend-developer", "copywriter"]);
    expect(filterDefs(catalog, { ...base, kind: "team" }).map((d) => d.id)).toEqual(["software-delivery-team"]);
  });

  it("filters by category", async () => {
    const { filterDefs } = await load();
    expect(filterDefs(catalog, { ...base, category: "Engineering" }).map((d) => d.id)).toEqual(["imported-agent", "frontend-developer"]);
    expect(filterDefs(catalog, { ...base, category: "All" })).toHaveLength(4);
  });

  it("sorts by most used, then catalogue order", async () => {
    const { filterDefs } = await load();
    const used = filterDefs(catalog, { ...base, sort: "used", usage: { "frontend-developer": 3, copywriter: 1 } });
    expect(used.map((d) => d.id)).toEqual(["frontend-developer", "copywriter", "data-analyst", "imported-agent"]);
  });

  it("sorts newest as reverse catalogue order, imported first", async () => {
    const { filterDefs } = await load();
    expect(filterDefs(catalog, { ...base, sort: "newest" }).map((d) => d.id)).toEqual(["imported-agent", "copywriter", "frontend-developer", "data-analyst"]);
  });

  it("keeps only imported or already-used experts under My experts", async () => {
    const { filterDefs } = await load();
    expect(filterDefs(catalog, { ...base, myExperts: true, usage: { "frontend-developer": 2 } }).map((d) => d.id)).toEqual(["imported-agent", "frontend-developer"]);
  });
});

describe("scenarios", () => {
  it("takes the fullest categories (team first, three rows each)", async () => {
    const { expertScenarios } = await load();
    const scenarios = expertScenarios(catalog);
    expect(scenarios[0]!.category).toBe("Engineering");
    expect(scenarios[0]!.items.map((d) => d.id)).toEqual(["software-delivery-team", "imported-agent", "frontend-developer"]);
    expect(scenarios.map((s) => s.category)).toEqual(["Engineering", "Data & AI", "Content & Creative"]);
  });
});

describe("usage counts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads an empty map, counts a summon, and ignores malformed storage", async () => {
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    });
    const { readUsage, bumpUsage } = await load();
    expect(readUsage()).toEqual({});
    expect(bumpUsage("data-analyst")).toEqual({ "data-analyst": 1 });
    expect(readUsage()).toEqual({ "data-analyst": 1 });
    backing.set("cubiq.expertUsage", "not json");
    expect(readUsage()).toEqual({});
  });
});

describe("ExpertCenter", () => {
  afterEach(() => vi.unstubAllGlobals());

  // `renderToStaticMarkup` reads zustand's initial state (no effects run), so seed it directly.
  const seed = (useStore: { getInitialState(): { experts: ExpertDef[] | null; selectedProjectId: string | null } }, patch: { experts: ExpertDef[] | null; selectedProjectId: string | null }) => {
    const state = useStore.getInitialState();
    const saved = { experts: state.experts, selectedProjectId: state.selectedProjectId };
    state.experts = patch.experts;
    state.selectedProjectId = patch.selectedProjectId;
    return () => {
      state.experts = saved.experts;
      state.selectedProjectId = saved.selectedProjectId;
    };
  };

  it("renders catalogue cards, counts and the Engines chip from the store", async () => {
    const { ExpertCenter, useStore } = await load();
    const restore = seed(useStore, { experts: catalog, selectedProjectId: "p1" });
    try {
      const html = strip(renderToStaticMarkup(<ExpertCenter />));
      expect(html).toContain("Data Analyst");
      expect(html).toContain("Frontend Developer");
      expect(html).toContain("Senior Frontend Engineer");
      expect(html).toContain("Search experts, roles or tags…");
      expect(html).toContain("Experts 4");
      expect(html).toContain("Teams 1");
      expect(html).toContain(">Engines<");
      expect(html).toContain("Software Delivery Team");
    } finally {
      restore();
    }
  });

  it("shows a loading line before the catalogue arrives", async () => {
    const { ExpertCenter, useStore } = await load();
    const restore = seed(useStore, { experts: null, selectedProjectId: "p1" });
    try {
      expect(renderToStaticMarkup(<ExpertCenter />)).toContain("Loading experts…");
    } finally {
      restore();
    }
  });
});

describe("ExpertCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens the detail from the card, from Enter, and summons from its button", async () => {
    const { ExpertCard } = await load();
    const onOpen = vi.fn();
    const onSummon = vi.fn();
    const tree = ExpertCard({ def: frontendDev, canSummon: true, onOpen, onSummon });

    const card = findAll(tree, (el) => el.props?.role === "button")[0]!;
    (card.props!.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledTimes(1);
    (card.props!.onKeyDown as (e: { key: string; preventDefault(): void }) => void)({ key: "Enter", preventDefault: () => {} });
    expect(onOpen).toHaveBeenCalledTimes(2);

    const event = { stopPropagation: vi.fn() };
    const summonBtn = findAll(tree, (el) => el.type === "button" && text(el.props!.children) === "Summon")[0]!;
    (summonBtn.props!.onClick as (e: unknown) => void)(event);
    expect(onSummon).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("tags a team with its size and disables Summon without a project", async () => {
    const { ExpertCard } = await load();
    const teamHtml = strip(renderToStaticMarkup(<ExpertCard def={team} canSummon onOpen={() => {}} onSummon={() => {}} />));
    expect(teamHtml).toContain("Team · 3");

    const tree = ExpertCard({ def: frontendDev, canSummon: false, onOpen: () => {}, onSummon: () => {} });
    const summonBtn = findAll(tree, (el) => el.type === "button" && text(el.props!.children) === "Summon")[0]!;
    expect(summonBtn.props!.disabled).toBe(true);
    expect(summonBtn.props!.title).toBe("Open a project first");
  });
});

describe("ExpertDetail", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists quick prompts, the team roster and stats, and wires Summon and a prompt", async () => {
    const { ExpertDetailContent } = await load();
    const onSummon = vi.fn();
    const onSummonPrompt = vi.fn();
    const props = { def: team, used: 2, canSummon: true, onClose: () => {}, onSummon, onSummonPrompt };
    const html = strip(renderToStaticMarkup(<ExpertDetailContent {...props} />));
    expect(html).toContain("Can help with");
    expect(html).toContain("Design and build a rate limiter");
    expect(html).toContain("Team");
    expect(html).toContain("Architect");
    expect(html).toContain("Reviewer");
    expect(html).toContain("Used 2×");
    expect(html).toContain("Imported");
    expect(html).toContain("A team runs several agents");
    expect(html).toContain("ID: software-delivery-team");

    const tree = ExpertDetailContent(props);
    const prompt = findAll(tree, (el) => el.props?.className === "xc-prompt")[0]!;
    (prompt.props!.onClick as () => void)();
    expect(onSummonPrompt).toHaveBeenCalledWith("Design and build a rate limiter");

    const summonBtn = findAll(tree, (el) => el.type === "button" && text(el.props!.children) === "Summon")[0]!;
    (summonBtn.props!.onClick as () => void)();
    expect(onSummon).toHaveBeenCalledTimes(1);
  });
});

describe("summon", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts the use and calls the store's summonExpert with the id and prompt", async () => {
    const { summon, useStore } = await load();
    const spy = vi.fn(async (_id: string, _prompt?: string) => "t1");
    const saved = useStore.getState().summonExpert;
    useStore.setState({ summonExpert: spy });
    try {
      summon(dataAnalyst);
      expect(spy).toHaveBeenCalledWith("data-analyst", undefined);
      summon(dataAnalyst, "Write SQL for weekly actives");
      expect(spy).toHaveBeenLastCalledWith("data-analyst", "Write SQL for weekly actives");
    } finally {
      useStore.setState({ summonExpert: saved });
    }
  });
});
