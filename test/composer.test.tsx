import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { describePick, type PickedElement } from "../src/main/browser/picker";
import { chipLabel, commandQuery, composeMessage, skillQueryAt, toggleSkill } from "../src/renderer/src/composer";
import { Composer } from "../src/renderer/src/components/Composer";
import { DesignFenceChip } from "../src/renderer/src/components/DesignSettingsMenu";
import { facetLabel } from "../src/renderer/src/components/DesignSystemMenu";
import { ThreadView } from "../src/renderer/src/components/ThreadView";
import { useStore } from "../src/renderer/src/store";
import type { AttachmentSource, SendRequest, StoredEvent, Thread } from "../src/shared/types";
import { EventRow } from "../src/renderer/src/components/ThreadView";
import { MAX_ATTACHMENT_BYTES, fileKind, pendingFrom, pendingFromPicked, shortName } from "../src/renderer/src/attachments";

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
        saveAttachments: async (_threadId: string, sources: AttachmentSource[]) =>
          sources.map((src, i) => ({ path: `.cubiq/attachments/id${i}-${src.name}`, name: src.name, size: 1, mediaType: "text/plain" })),
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

  it("copies a queued message's files into the thread, then sends them as attachments", async () => {
    const s = useStore.getState();
    s.enqueue("t", "see file", undefined, undefined, [{ name: "a.txt", path: "/x/a.txt" }]);
    s.apply({ type: "running", threadId: "t", running: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([{ threadId: "t", text: "see file", attachments: [{ path: ".cubiq/attachments/id0-a.txt", name: "a.txt", size: 1, mediaType: "text/plain" }] }]);
  });

  it("Retry re-sends the attachments the thread already holds, without copying again", async () => {
    useStore.setState({ running: {} });
    const held = { path: ".cubiq/attachments/k-r.pdf", name: "r.pdf", size: 4, mediaType: "application/pdf" };
    await useStore.getState().send("again", undefined, "t", undefined, { attachments: [held] });
    expect(sent).toEqual([{ threadId: "t", text: "again", attachments: [held] }]);
  });

  it("queues the exact plugin command/skill revisions and does not substitute an Update at drain", () => {
    const skill = { name: "p-notes-review", origin: "plugin", owner: { key: "g~notes", title: "Notes", enabled: true, revision: "one" } } as import("../src/shared/types").SkillEntry;
    useStore.setState({ skills: [skill] });
    const pluginCommand = { key: "g~notes", name: "review", revision: "one" };
    useStore.getState().enqueue("t", "/notes.review", [skill.name], undefined, undefined, { pluginCommand });
    useStore.setState({ skills: [{ ...skill, owner: { ...skill.owner!, revision: "two" } }] });
    useStore.getState().apply({ type: "running", threadId: "t", running: false });
    expect(sent[0]).toMatchObject({ pluginCommand, pluginSkills: [{ key: "g~notes", name: skill.name, revision: "one" }] });
    useStore.setState({ skills: [] });
  });

  it("Retry sends saved plugin identities rather than resolving current skill ownership", async () => {
    useStore.setState({ running: {}, skills: [] });
    const pluginCommand = { key: "g~notes", name: "review", revision: "old" }, pluginSkills = [{ key: "g~notes", name: "p-notes-review", revision: "old" }];
    await useStore.getState().send("again", ["p-notes-review"], "t", undefined, { pluginCommand, pluginSkills });
    expect(sent[0]).toMatchObject({ pluginCommand, pluginSkills });
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

describe("facetLabel", () => {
  it("labels a style's facets in one line", () => {
    expect(facetLabel({ theme: "light", darkPair: true, display: "sans", shape: "sharp" })).toBe("Light + dark · Sans type · Sharp corners");
    expect(facetLabel({ theme: "dark", darkPair: false, display: "mono", shape: "round" })).toBe("Dark · Mono type · Round corners");
  });
});

describe("attachments in the composer and transcript", () => {
  it("keeps to 10 files and 20 MB, naming what it left out", async () => {
    const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt"), { name: "big.bin", size: MAX_ATTACHMENT_BYTES + 1, type: "" } as File];
    const { added, refused } = await pendingFrom(files, 1, () => "");
    expect(added.map((a) => a.name)).toEqual(["a.txt"]);
    expect("bytes" in added[0]!.source).toBe(true);
    expect(refused).toEqual(["b.txt (at most 10 files per message)", "big.bin (over 20 MB)"]);
  });

  it("takes a dropped file by its path, not its bytes", async () => {
    const { added } = await pendingFrom([new File(["a"], "a.txt")], 10, () => "/Users/me/a.txt");
    expect(added[0]!.source).toEqual({ name: "a.txt", path: "/Users/me/a.txt" });
    expect(pendingFromPicked([{ name: "p.pdf", path: "/p.pdf", size: 3 }], 10).added[0]).toMatchObject({ name: "p.pdf", size: 3, source: { name: "p.pdf", path: "/p.pdf" } });
  });

  it("cuts long names in the middle so the extension stays", () => {
    expect(shortName("short.png")).toBe("short.png");
    const cut = shortName("redacted-screenshot-of-the-quarterly-dashboard.png");
    expect(cut.length).toBe(26);
    expect(cut).toMatch(/^redacted-scree.*….*board\.png$/);
    expect(shortName("a".repeat(40)).length).toBe(26);
  });

  it("gives Word, Excel, slides, archives and code their own kind", () => {
    expect(fileKind("plan.docx")).toBe("doc");
    expect(fileKind("Budget.XLSX")).toBe("sheet");
    expect(fileKind("data.csv")).toBe("sheet");
    expect(fileKind("deck.pptx")).toBe("slides");
    expect(fileKind("src.zip")).toBe("archive");
    expect(fileKind("main.py")).toBe("code");
    expect(fileKind("report.pdf")).toBe("pdf");
    expect(fileKind("pasted", "image/png")).toBe("image");
    expect(fileKind("blob.bin", "application/octet-stream")).toBe("file");
  });

  it("shows a sent message's attachments as chips above the bubble: image thumbnail or type icon, name, size", () => {
    const stored: StoredEvent = {
      seq: 1,
      createdAt: 0,
      event: {
        kind: "user",
        text: "look",
        attachments: [
          { path: ".cubiq/attachments/k-shot.png", name: "shot.png", size: 2048, mediaType: "image/png" },
          { path: ".cubiq/attachments/k-r.pdf", name: "r.pdf", size: 10, mediaType: "application/pdf" },
          { path: ".cubiq/attachments/k-budget.xlsx", name: "budget.xlsx", size: 10, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        ],
      },
    } as StoredEvent;
    const html = renderToStaticMarkup(<EventRow stored={stored} results={new Map()} running={false} threadId="t 1" />);
    expect(html).toContain('class="msg-attachments"');
    expect(html).toContain('src="cubiq-file://f/t%201/.cubiq/attachments/k-shot.png"');
    expect(html).toContain('aria-label="Open r.pdf"');
    expect(html).toContain("10 B");
    expect(html).toContain('class="attach-thumb"');
    expect(html).toContain(">shot.png<");
    expect(html).toContain('data-kind="sheet"');
    expect(html).toContain(">XLS</text>");
    expect(html).toContain(">PDF</text>");
    expect(html).toContain('data-kind="pdf"');
    expect(html.indexOf("msg-attachments")).toBeLessThan(html.indexOf('class="bubble"'));
  });

  it("a files-only message has no empty bubble", () => {
    const stored = { seq: 1, createdAt: 0, event: { kind: "user", text: "", attachments: [{ path: ".cubiq/attachments/k-r.pdf", name: "r.pdf", size: 10, mediaType: "application/pdf" }] } } as StoredEvent;
    expect(renderToStaticMarkup(<EventRow stored={stored} results={new Map()} running={false} threadId="t" />)).not.toContain('class="bubble"');
  });
});
