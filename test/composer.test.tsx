import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { describePick, type PickedElement } from "../src/main/browser/picker";
import { chipLabel, commandQuery, composeMessage, skillQueryAt, toggleSkill } from "../src/renderer/src/composer";
import { Composer } from "../src/renderer/src/components/Composer";
import { DesignFenceChip } from "../src/renderer/src/components/DesignSettingsMenu";
import { chipStyle, DesignStyleMenu, facetLabel, filterStyles, initialPreviewTheme, previewable, stepPreview, styleGroups } from "../src/renderer/src/components/DesignSystemMenu";
import type { DesignSystemOption, StyleFacets } from "../src/shared/types";
import { ThreadView } from "../src/renderer/src/components/ThreadView";
import { useStore } from "../src/renderer/src/store";
import type { SendRequest, Thread } from "../src/shared/types";

const element: PickedElement = { selector: "button.primary", tag: "button", text: "Save", html: "<button class=\"primary\">Save</button>", rect: { x: 0, y: 0, width: 1, height: 1 } };
const picked = describePick(element, "http://localhost:3000/");

describe("chipLabel", () => {
  it("names a picked element by its selector", () => {
    expect(chipLabel(picked)).toBe("button.primary");
  });

  it("falls back to the first line, clipped", () => {
    expect(chipLabel("\nsome long context line that keeps going and going", 20)).toBe("some long context l…");
  });
});

describe("composeMessage", () => {
  it("sends what was typed, then each chip's full text", () => {
    expect(composeMessage("  make it blue ", [picked])).toBe(`make it blue\n\n${picked}`);
  });

  it("sends a chip alone", () => {
    expect(composeMessage("", [picked])).toBe(picked);
  });
});

describe("composer menu triggers", () => {
  it("opens the skill menu on a $ at a word start, up to the caret", () => {
    expect(skillQueryAt("$tdd", 4)).toEqual({ start: 0, query: "tdd" });
    expect(skillQueryAt("$", 1)).toEqual({ start: 0, query: "" });
    expect(skillQueryAt("fix login $Rev", 14)).toEqual({ start: 10, query: "rev" });
    // The caret decides: text after it doesn't count.
    expect(skillQueryAt("$tdd fix", 2)).toEqual({ start: 0, query: "t" });
  });

  it("doesn't open the skill menu mid-word, for /, or once whitespace is typed", () => {
    expect(skillQueryAt("/tdd", 4)).toBeNull();
    expect(skillQueryAt("$td d", 5)).toBeNull();
    expect(skillQueryAt("costs a$5", 9)).toBeNull();
    expect(skillQueryAt("no trigger", 10)).toBeNull();
  });

  it("toggles a skill in the picked list, keeping order", () => {
    expect(toggleSkill([], "tdd")).toEqual(["tdd"]);
    expect(toggleSkill(["tdd"], "review")).toEqual(["tdd", "review"]);
    expect(toggleSkill(["tdd", "review"], "tdd")).toEqual(["review"]);
  });

  it("opens the command menu on a leading /", () => {
    expect(commandQuery("/plan")).toBe("plan");
    expect(commandQuery("/")).toBe("");
  });

  it("doesn't open the command menu for $ or once whitespace is typed", () => {
    expect(commandQuery("$plan")).toBeNull();
    expect(commandQuery("/pl an")).toBeNull();
    expect(commandQuery("run /plan")).toBeNull();
  });
});

describe("queued send", () => {
  const sent: SendRequest[] = [];
  const interrupted: string[] = [];
  (globalThis as { window?: unknown }).window = {
    unskilled: new Proxy(
      {
        send: async (r: SendRequest) => void sent.push(r),
        interrupt: async (id: string) => void interrupted.push(id),
        createThread: async (pid: string, _agent?: string, opts?: { worktree?: boolean }) => ({
          id: "t-bg",
          projectId: pid,
          agent: "claude",
          title: "New thread",
          sessionId: null,
          bindings: {},
          model: "opus",
          effort: null,
          permissionMode: "ask",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...(opts?.worktree ? { branch: "harness/bg", worktreePath: "/wt/bg" } : {}),
        }),
      } as Record<string, unknown>,
      { get: (target, key: string) => target[key] ?? (async () => null) },
    ),
  };

  beforeEach(() => {
    sent.length = 0;
    interrupted.length = 0;
    useStore.setState({ selectedThreadId: "t", running: { t: true }, outbox: {}, finished: [], turnStartedAt: {} });
  });

  it("delivers a message queued mid-turn exactly once, as the next turn", () => {
    const s = useStore.getState();
    s.enqueue("t", "and add a test", ["tdd", "review"]);
    expect(useStore.getState().outbox.t).toEqual([{ text: "and add a test", skills: ["tdd", "review"] }]);
    s.apply({ type: "running", threadId: "t", running: false });
    expect(sent).toEqual([{ threadId: "t", text: "and add a test", skills: ["tdd", "review"] }]);
    expect(useStore.getState().outbox.t).toEqual([]);
    s.apply({ type: "running", threadId: "t", running: true });
    s.apply({ type: "running", threadId: "t", running: false });
    expect(sent).toHaveLength(1);
  });

  it("sends queued messages one turn at a time, in order", () => {
    const s = useStore.getState();
    s.enqueue("t", "first");
    s.enqueue("t", "second");
    s.apply({ type: "running", threadId: "t", running: false });
    expect(sent.map((r) => r.text)).toEqual(["first"]);
    s.apply({ type: "running", threadId: "t", running: true });
    s.apply({ type: "running", threadId: "t", running: false });
    expect(sent.map((r) => r.text)).toEqual(["first", "second"]);
  });

  it("clears the queue on Stop, before the turn's end could deliver it", async () => {
    const s = useStore.getState();
    s.enqueue("t", "never mind");
    await s.interrupt();
    expect(interrupted).toEqual(["t"]);
    s.apply({ type: "running", threadId: "t", running: false });
    expect(sent).toEqual([]);
    expect(useStore.getState().outbox.t).toBeUndefined();
  });

  describe("sendInBackground", () => {
    it("starts the message in its own thread and leaves the current one selected", async () => {
      useStore.setState({ selectedProjectId: "p", selectedThreadId: "keep", running: {}, threads: {}, events: {} });
      await useStore.getState().sendInBackground("do it", ["tdd"], undefined, ["src/a.ts"]);
      expect(sent).toEqual([{ threadId: "t-bg", text: "do it", skills: ["tdd"], mentions: ["src/a.ts"], background: true }]);
      expect(useStore.getState().selectedThreadId).toBe("keep");
      expect(useStore.getState().threads.p!.map((t) => t.id)).toEqual(["t-bg"]);
    });
  });

  describe("startThread routing", () => {
    const raws = (window as unknown as { unskilled: Record<string, unknown> }).unskilled;
    const mkThread = (id: string, projectId: string): Thread => ({
      id,
      projectId,
      agent: "claude",
      title: "New thread",
      sessionId: null,
      bindings: {},
      model: "opus",
      effort: null,
      permissionMode: "ask",
      createdAt: 0,
      updatedAt: 0,
    });

    it("sends to the thread newThread created, not one picked while it awaited", async () => {
      const original = raws.createThread;
      let release!: (t: Thread) => void;
      raws.createThread = () => new Promise<Thread>((resolve) => { release = resolve; });
      try {
        useStore.setState({ selectedProjectId: "p", selectedThreadId: null, draft: {}, threads: {}, events: {}, running: {} });
        const started = useStore.getState().startThread("write it");
        // The user jumps to another thread while the create is still in flight…
        useStore.setState({ selectedThreadId: "other" });
        release(mkThread("t-new", "p"));
        // …and again after the new thread lands but before startThread's await resumes.
        await Promise.resolve();
        useStore.setState({ selectedThreadId: "other" });
        await started;
        expect(sent).toEqual([{ threadId: "t-new", text: "write it" }]);
      } finally {
        raws.createThread = original;
      }
    });

    it("sends nothing when no thread was created", async () => {
      useStore.setState({ selectedProjectId: null, selectedThreadId: "t", running: {} });
      await useStore.getState().startThread("write it");
      expect(sent).toEqual([]);
    });
  });
});

describe("dequeue", () => {
  it("removes only the message at that index", () => {
    useStore.setState({ outbox: { t: [{ text: "a" }, { text: "b" }, { text: "c" }] } });
    useStore.getState().dequeue("t", 1);
    expect(useStore.getState().outbox.t).toEqual([{ text: "a" }, { text: "c" }]);
  });

  it("drops the thread's key once its queue is empty", () => {
    useStore.setState({ outbox: { t: [{ text: "only" }, { text: "two" }] } });
    useStore.getState().dequeue("t", 0);
    expect(useStore.getState().outbox.t).toEqual([{ text: "two" }]);
    useStore.getState().dequeue("t", 0);
    expect("t" in useStore.getState().outbox).toBe(false);
  });
});

describe("queued message bubbles", () => {
  // Server rendering reads zustand's initial state; seed it, then restore.
  const withOutbox = (outbox: Record<string, { text: string; skills?: string[] }[]>, fn: () => void) => {
    const state = useStore.getInitialState();
    const saved = state.outbox;
    try {
      state.outbox = outbox;
      fn();
    } finally {
      state.outbox = saved;
    }
  };

  it("shows the skills a / command runs as /name, other skills as $name", () => {
    const state = useStore.getInitialState();
    const saved = state.skills;
    try {
      state.skills = [
        { name: "issue-setup", origin: "bundled", description: "" },
        { name: "review", origin: "bundled", description: "" },
      ] as typeof state.skills;
      withOutbox({ t: [{ text: "go", skills: ["issue-setup", "review"] }] }, () => {
        const html = renderToStaticMarkup(<ThreadView threadId="t" />);
        expect(html).toContain('<span class="skill-chip">/issue-setup</span>');
        expect(html).toContain('<span class="skill-chip">$review</span>');
      });
    } finally {
      state.skills = saved;
    }
  });

  it("shows an issue offer as a File issue? card with File and Dismiss, gone once a later message exists", () => {
    const state = useStore.getInitialState();
    const saved = state.events;
    const offer = { kind: "issue-offer" as const, type: "bug" as const, title: "isEven returns false for even numbers", summary: "util.js:2" };
    const ev = (seq: number, event: unknown) => ({ seq, createdAt: seq, event }) as (typeof state.events)[string][number];
    try {
      state.events = { t: [ev(1, { kind: "user", text: "go" }), ev(2, { kind: "assistant-text", text: "It fails." }), ev(3, offer)] };
      const html = renderToStaticMarkup(<ThreadView threadId="t" />);
      expect(html).toContain("File issue?");
      expect(html).toContain("isEven returns false for even numbers");
      expect(html).toContain(">Dismiss</button>");
      expect(html).toContain(">File</button>");
      state.events = { t: [...state.events.t!, ev(4, { kind: "user", text: "next" })] };
      expect(renderToStaticMarkup(<ThreadView threadId="t" />)).not.toContain("File issue?");
    } finally {
      state.events = saved;
    }
  });

  it("gives each queued message a remove button", () => {
    withOutbox({ t: [{ text: "first" }, { text: "second" }] }, () => {
      const html = renderToStaticMarkup(<ThreadView threadId="t" />);
      expect(html.match(/aria-label="Remove queued message"/g) ?? []).toHaveLength(2);
    });
  });
});

describe("composer actions row", () => {
  // Server rendering reads zustand's initial state; seed it, then restore.
  const withRunning = (running: Record<string, boolean>, fn: () => void) => {
    const state = useStore.getInitialState();
    const saved = state.running;
    try {
      state.running = running;
      fn();
    } finally {
      state.running = saved;
    }
  };

  it("keeps Stop inside composer-actions while running", () => {
    withRunning({ t: true }, () => {
      const html = renderToStaticMarkup(<Composer threadId="t" />);
      expect(html).toMatch(/<div class="composer-actions"><button class="send stop"/);
    });
  });

  it("keeps Send inside composer-actions when idle", () => {
    withRunning({}, () => {
      const html = renderToStaticMarkup(<Composer threadId="t" />);
      expect(html).toMatch(/<div class="composer-actions"><button class="send"/);
    });
  });

  it("keeps composer-actions a direct child of composer-bar, outside composer-left", () => {
    withRunning({ t: true }, () => {
      const html = renderToStaticMarkup(<Composer threadId="t" />);
      // The wrapping lives in composer-left; the actions row is its sibling in the bar.
      expect(html).toMatch(/<div class="composer-bar"><div class="composer-left">/);
      expect(html).toMatch(/<\/div><div class="composer-actions">/);
      const left = /<div class="composer-left">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
      expect(left).not.toContain("composer-actions");
      // No meters prop: no wrapper is rendered at all.
      expect(html).not.toContain("composer-meters");
    });
  });

  it("shows the queue placeholder while running, and no inline hint", () => {
    withRunning({ t: true }, () => {
      const html = renderToStaticMarkup(<Composer threadId="t" />);
      expect(html).toContain('placeholder="Queue a message for the next turn…"');
      expect(html).not.toContain("Return queues for the next turn");
    });
  });

  it("keeps the idle placeholder when not running", () => {
    withRunning({}, () => {
      const html = renderToStaticMarkup(<Composer threadId="t" />);
      expect(html).toContain('placeholder="Ask anything — $ for a skill, / for a command"');
    });
  });

  it("puts the model control and the meters in composer-actions, before Stop/Send", () => {
    withRunning({ t: true }, () => {
      const html = renderToStaticMarkup(<Composer threadId="t" model={<span className="m">Model</span>} meters={<span className="x">M</span>} />);
      expect(html).toMatch(/<div class="composer-actions"><span class="m">Model<\/span><span class="x">M<\/span><button class="send stop"/);
      expect(html).not.toContain("composer-meters");
    });
  });

  it("puts + and the permission chip first in composer-left", () => {
    withRunning({}, () => {
      const html = renderToStaticMarkup(<Composer threadId="t" mode={<span className="mode">Ask</span>} />);
      expect(html).toMatch(/<div class="composer-left"><div class="goo">[\s\S]*?<button class="chip-button icon goo-main" title="Add context"[\s\S]*?<span class="mode">Ask<\/span>/);
    });
  });

  it("shows the full chips, not the folded ones, until the bar is measured too narrow", () => {
    withRunning({}, () => {
      const html = renderToStaticMarkup(<Composer threadId="t" mode={<span className="mode">Ask</span>} compactMode={<span className="merged">All</span>} />);
      expect(html).toContain('<span class="mode">Ask</span>');
      expect(html).not.toContain("merged");
      expect(html).toContain('class="composer-bar"');
    });
  });

  it("marks the composer running for the beam", () => {
    withRunning({ t: true }, () => expect(renderToStaticMarkup(<Composer threadId="t" />)).toContain('class="composer running"'));
    withRunning({}, () => expect(renderToStaticMarkup(<Composer threadId="t" />)).toContain('class="composer"'));
  });
});

describe("DesignFenceChip", () => {
  it("shows fenced Full access as a chip that explains itself, with nothing to pick", () => {
    const html = renderToStaticMarkup(<DesignFenceChip />);
    expect(html).toContain("design-fence-chip");
    expect(html).toMatch(/aria-label="Full access, fenced to this design&#x27;s folder"/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("listbox");
  });
});

describe("DesignStyleMenu", () => {
  const opt = (id: string, name: string, source: DesignSystemOption["source"]): DesignSystemOption => ({ id, name, description: "", swatches: ["#000", "#fff"], source });
  const facets = (over: Partial<StyleFacets>): StyleFacets => ({ theme: "light", darkPair: false, display: "sans", shape: "soft", ...over });
  const faceted = (id: string, name: string, over: Partial<StyleFacets>): DesignSystemOption => ({ ...opt(id, name, "style"), facets: facets(over) });
  const options = [opt("project", "Project", "project"), opt("style:zinc-console", "Zinc console", "style"), opt("style:clean-inset", "Clean inset", "style")];

  it("reads nothing picked, Auto, or a gone style as Auto, and names Auto's pick once it has one", () => {
    expect(chipStyle(options, undefined).name).toBe("Auto");
    expect(chipStyle(options, "auto").id).toBe("auto");
    expect(chipStyle(options, "style:retired").name).toBe("Auto");
    expect(chipStyle(options, "auto", { surface: "page", mode: "operate", style: "style:zinc-console", tier: "working" }).name).toBe("Auto · Zinc console");
  });

  it("shows a fixed style by name", () => {
    expect(chipStyle(options, "style:clean-inset")).toEqual({ id: "style:clean-inset", name: "Clean inset", title: "Style: Clean inset" });
  });

  it("lists Auto first, then the project's systems, then the styles", () => {
    expect(styleGroups(options).map((g) => [g.label, g.options.map((o) => o.id)])).toEqual([
      ["", ["auto"]],
      ["Project", ["project"]],
      ["Styles", ["style:zinc-console", "style:clean-inset"]],
    ]);
    expect(styleGroups(options.slice(1)).map((g) => g.label)).toEqual(["", "Styles"]);
  });

  it("renders a style chip with no palette, disabled while running", () => {
    const html = renderToStaticMarkup(<DesignStyleMenu projectId={null} value={undefined} disabled onPick={() => {}} />);
    expect(html).toContain("ds-chip");
    expect(html).toContain('aria-label="Style: Auto (picks one that fits the brief)"');
    expect(html).not.toContain("swatch");
    expect(html).toContain("disabled");
  });

  it("keeps project systems and filters styles by theme, display or both", () => {
    const list = [
      { ...opt("project", "Project", "project"), facets: facets({ theme: "dark", display: "mono" }) },
      faceted("style:light-sans", "Light sans", { theme: "light", display: "sans" }),
      faceted("style:dark-mono", "Dark mono", { theme: "dark", display: "mono" }),
      opt("style:plain", "Plain", "style"),
    ];
    expect(filterStyles(list, { theme: null, display: null }).map((o) => o.id)).toEqual(["project", "style:light-sans", "style:dark-mono", "style:plain"]);
    expect(filterStyles(list, { theme: "dark", display: null }).map((o) => o.id)).toEqual(["project", "style:dark-mono"]);
    expect(filterStyles(list, { theme: null, display: "sans" }).map((o) => o.id)).toEqual(["project", "style:light-sans"]);
    expect(filterStyles(list, { theme: "dark", display: "mono" }).map((o) => o.id)).toEqual(["project", "style:dark-mono"]);
    expect(filterStyles(list, { theme: "light", display: "mono" }).map((o) => o.id)).toEqual(["project"]);
  });

  it("previews only entries with facets, Auto aside", () => {
    const list = [{ ...opt("project", "Project", "project"), facets: facets({}) }, opt("auto", "Auto", "project"), opt("style:plain", "Plain", "style")];
    expect(previewable(list).map((o) => o.id)).toEqual(["project"]);
  });

  it("steps previews with wrap-around and keeps an unlisted id", () => {
    const list = [faceted("a", "A", {}), faceted("b", "B", {}), faceted("c", "C", {})];
    expect(stepPreview(list, "a", 1)).toBe("b");
    expect(stepPreview(list, "c", 1)).toBe("a");
    expect(stepPreview(list, "a", -1)).toBe("c");
    expect(stepPreview(list, "gone", 1)).toBe("gone");
  });

  it("labels a style's facets in one line", () => {
    expect(facetLabel({ theme: "light", darkPair: true, display: "sans", shape: "sharp" })).toBe("Light + dark · Sans type · Sharp corners");
    expect(facetLabel({ theme: "dark", darkPair: false, display: "mono", shape: "round" })).toBe("Dark · Mono type · Round corners");
  });

  it("opens a dark pair in the app's theme, and a dark-only style in its own", () => {
    const pair = facets({ theme: "light", darkPair: true });
    expect(initialPreviewTheme(pair, true)).toBe("dark");
    expect(initialPreviewTheme(pair, false)).toBe("light");
    expect(initialPreviewTheme(facets({ theme: "dark", darkPair: false }), false)).toBe("dark");
  });
});
