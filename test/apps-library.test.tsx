import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppInfo, Thread } from "../src/shared/types";
import { AppsTabView, type AppsTabViewProps } from "../src/renderer/src/components/AppsTab";
import { LibrarySheet } from "../src/renderer/src/components/Library";
import { hostOf, useStore } from "../src/renderer/src/store";
import { shownSurfaces } from "../src/renderer/src/components/PluginHost";

const app: AppInfo = { key: "g~sales", name: "sales", title: "Sales", description: "Daily revenue", scope: "global", path: "/profile/apps/sales", url: "cubiq-app://a/g~sales/index.html", grants: [{ server: "shop", tools: ["summary", "refund"] }] };
const thread: Thread = { id: "new", projectId: "p", kind: "chat", preset: "creator", title: "New", agent: "codex", model: "m", effort: null, sessionId: null, bindings: {}, permissionMode: "ask", createdAt: 0, updatedAt: 0 };
const view = (over: Partial<AppsTabViewProps> = {}) => renderToStaticMarkup(<AppsTabView apps={[app]} selected={app.key} query="" loading={false} error={null} busy={null} confirm={false} managed onQuery={() => {}} onSelect={() => {}} onRetry={() => {}} onOpen={() => {}} onEnable={() => {}} onEdit={() => {}} onConfirm={() => {}} onUninstall={() => {}} {...over} />);

afterEach(() => { vi.unstubAllGlobals(); useStore.setState(useStore.getInitialState()); });

describe("Library apps", () => {
  it("offers an Apps tab and all management actions with the granted tool names", () => {
    const library = renderToStaticMarkup(<LibrarySheet tab="apps" />);
    expect(library).toContain('id="library-tab-apps"');
    expect(library).toContain('role="tabpanel"');
    const html = view();
    for (const text of ["Open app", "Edit with Creator", "Turn off", "Uninstall", "shop.summary", "shop.refund", "Update card"]) expect(html).toContain(text);
    expect(html).not.toContain("scope picker");
  });

  it("lists disabled apps, disables Open, and explains how to enable them", () => {
    const html = view({ apps: [{ ...app, enabled: false }] });
    expect(html).toContain("Off · ");
    expect(html).toMatch(/disabled=""[^>]*>Open app/);
    expect(html).toContain(">Turn on</button>");
    expect(html).toContain("Its saved data is kept");
    expect(html).not.toMatch(/disabled=""[^>]*>Edit with Creator/);
  });

  it("gives each plugin row a star, an on/off switch, Open and a menu, and lists built-in features with their switches", async () => {
    const { builtinsOf, builtinPatch } = await import("../src/renderer/src/components/AppsTab");
    const builtins = builtinsOf({ memory: { enabled: true, disabledProjects: [] }, codeMode: "off", uiBlocks: true } as never);
    const html = view({ apps: [{ ...app, favorite: 5 }], builtins });
    expect(html).toContain('aria-label="Favourite Sales"');
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Favourite Sales"/);
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Sales on"/);
    expect(html).toContain('aria-label="Open Sales"');
    expect(html).toContain('aria-label="Sales options"');
    expect(html).toContain(">Built in<");
    expect(html).toMatch(/aria-checked="true" aria-label="Memory on"/);
    expect(html).toMatch(/aria-checked="false" aria-label="Code mode off"/);
    expect(html).toMatch(/aria-checked="true" aria-label="Inline UI on"/);
    expect(builtinPatch("codeMode", true)).toEqual({ codeMode: "on" });
    expect(builtinPatch("memory", false)).toEqual({ memory: { enabled: false } });
    expect(builtinPatch("uiBlocks", false)).toEqual({ uiBlocks: false });
    expect(renderToStaticMarkup(<LibrarySheet tab="apps" />)).toContain(">Plugins<");
  });

  it("shows loading, empty, filtered, error, busy and uninstall confirmation states", () => {
    expect(view({ apps: [], loading: true })).toContain("Loading apps…");
    expect(view({ apps: [] })).toContain("No apps yet. Turn on Creator");
    expect(view({ query: "no-match" })).toContain("No matching apps.");
    expect(view({ error: "The file was modified" })).toContain('role="alert"');
    expect(view({ busy: { key: app.key, action: "edit" } })).toContain("Preparing draft…");
    const html = view({ confirm: true });
    expect(html).toContain("Confirm uninstall");
    expect(html).toContain("Connectors are kept.");
    expect(view({ managed: false })).toMatch(/disabled=""[^>]*>Uninstall/);
  });
});

describe("app store actions", () => {
  it("closes an installed pane when disabled or removed, but keeps drafts", async () => {
    const listApps = vi.fn(async () => [{ ...app, enabled: false }]);
    vi.stubGlobal("window", { unskilled: { listApps } });
    useStore.setState({ selectedProjectId: "p", appOpen: app, inspectorOpen: false });
    await useStore.getState().loadApps();
    expect(useStore.getState()).toMatchObject({ appOpen: null, inspectorOpen: false });
    const draft = { ...app, key: "d~new~sales", scope: "draft" as const };
    useStore.setState({ appOpen: draft });
    await useStore.getState().loadApps();
    expect(useStore.getState().appOpen).toEqual(draft);
    listApps.mockResolvedValue([]);
    useStore.setState({ appOpen: app });
    await useStore.getState().loadApps();
    expect(useStore.getState().appOpen).toBeNull();
  });

  it("opens a modal app in the plugin modal and never in the right panel", () => {
    useStore.setState({ appOpen: null, inspectorOpen: false, inspectorTab: "changes", surfaceDrafts: [], surfaceHidden: [] });
    useStore.getState().openApp(app);
    expect(useStore.getState()).toMatchObject({ appOpen: app, inspectorOpen: false, inspectorTab: "changes" });
    useStore.getState().closeApp();
    expect(useStore.getState().appOpen).toBeNull();
  });

  it("shows a floating app as a widget: drafts until closed, installed ones hide and come back", () => {
    const widget = { ...app, key: "g~timer", name: "timer", placement: "floating" as const, size: { width: 260, height: 150 } };
    const draft = { ...widget, key: "d~t1~timer", scope: "draft" as const };
    useStore.setState({ appOpen: null, inspectorOpen: false, surfaceDrafts: [], surfaceHidden: [], surfaceFocus: null });
    useStore.getState().openApp(draft);
    expect(useStore.getState()).toMatchObject({ appOpen: null, inspectorOpen: false, surfaceDrafts: [draft], surfaceFocus: { key: draft.key, n: 1 } });
    useStore.getState().openApp(draft);
    expect(useStore.getState().surfaceDrafts).toEqual([draft]);
    useStore.getState().closeSurface(draft.key);
    expect(useStore.getState().surfaceDrafts).toEqual([]);
    useStore.getState().closeSurface(widget.key);
    expect(useStore.getState().surfaceHidden).toEqual([widget.key]);
    useStore.getState().openApp(widget);
    expect(useStore.getState().surfaceHidden).toEqual([]);
    expect(useStore.getState().surfaceFocus?.key).toBe(widget.key);
  });

  it("a draft that turns floating leaves the modal for its widget", () => {
    const modalDraft = { ...app, key: "d~t1~sales", scope: "draft" as const };
    useStore.setState({ appOpen: modalDraft, surfaceDrafts: [] });
    useStore.getState().openApp({ ...modalDraft, placement: "floating" });
    expect(useStore.getState().appOpen).toBeNull();
    expect(useStore.getState().surfaceDrafts).toHaveLength(1);
  });

  it("opens an installed page in the main area, a draft page in the modal, and closes the page on a thread change", async () => {
    const page = { ...app, key: "g~reading", name: "reading", placement: "page" as const };
    useStore.setState({ appOpen: null, appPage: null, surfaceDrafts: [] });
    useStore.getState().openApp(page);
    expect(useStore.getState()).toMatchObject({ appPage: page, appOpen: null });
    const draft = { ...page, key: "d~t1~reading", scope: "draft" as const };
    useStore.getState().openApp(draft);
    expect(useStore.getState()).toMatchObject({ appOpen: draft });
    expect(hostOf(draft)).toBe("modal");
    useStore.setState({ threads: {}, selectedOrder: [] });
    await useStore.getState().selectThread(null);
    expect(useStore.getState().appPage).toBeNull();
  });

  it("shows docks and panels as surfaces: installed unless closed, drafts beside them, each in its own placement", () => {
    const dock = { ...app, key: "g~focus", name: "focus", placement: "dock" as const, height: 40 };
    const panel = { ...app, key: "g~queue", name: "queue", placement: "panel" as const, height: 160 };
    const off = { ...dock, key: "g~off", name: "off", enabled: false };
    const draftDock = { ...dock, key: "d~t1~focus2", name: "focus2", scope: "draft" as const };
    expect(shownSurfaces([dock, panel, off], [], [draftDock], "dock").map((a) => a.key)).toEqual(["g~focus", "d~t1~focus2"]);
    expect(shownSurfaces([dock, panel], [panel.key], [], "panel")).toEqual([]);
    expect(shownSurfaces([dock, panel], [], [draftDock], "floating")).toEqual([]);
    useStore.setState({ surfaceHidden: [dock.key], surfaceFocus: null, appOpen: null });
    useStore.getState().openApp(dock);
    expect(useStore.getState()).toMatchObject({ surfaceHidden: [], appOpen: null, surfaceFocus: { key: dock.key } });
  });

  it("bridges notify, openPlugin and ask: toasts with the title, opens only installed plugins, fills a new chat's composer", async () => {
    const notices: string[] = [];
    const other = { ...app, key: "g~notes", name: "notes", title: "Notes" };
    useStore.setState({ apps: [app, other], appOpen: null, showNotice: (t: string) => void notices.push(t) });
    useStore.getState().pluginNotify(app, "  Saved\n3 items ");
    useStore.getState().pluginOpen(app, "notes");
    expect(useStore.getState().appOpen?.key).toBe("g~notes");
    useStore.getState().pluginOpen(app, "missing");
    const newChat = vi.fn(async () => "t2");
    useStore.setState({ newChat, appPage: { ...app, placement: "page" } });
    await useStore.getState().pluginAsk(app, "  Plan my day  ");
    expect(newChat).toHaveBeenCalledOnce();
    expect(useStore.getState()).toMatchObject({ appPage: null, appOpen: null, composerDraft: { text: "Plan my day" } });
    expect(notices).toEqual(["Sales: Saved 3 items", 'Sales tried to open "missing", which isn\'t installed.', "Sales started a chat. Read it, then send it."]);
  });

  it("refreshes an updated app's pane info and rejects a stale project reply", async () => {
    const updated = { ...app, title: "New title", url: "cubiq-app://a/g~sales/new.html" };
    vi.stubGlobal("window", { unskilled: { listApps: async () => [updated] } });
    useStore.setState({ selectedProjectId: "p", appOpen: app });
    await useStore.getState().loadApps();
    expect(useStore.getState().appOpen).toEqual(updated);
    let release!: (list: AppInfo[]) => void;
    vi.stubGlobal("window", { unskilled: { listApps: () => new Promise<AppInfo[]>((r) => { release = r; }) } });
    const pending = useStore.getState().loadApps();
    useStore.setState({ selectedProjectId: "other" });
    release([]);
    await pending;
    expect(useStore.getState().appOpen).toEqual(updated);
  });

  it("creates a Creator draft in the selected connector context without sending a turn", async () => {
    const createThread = vi.fn(async () => thread);
    const prepareAppEdit = vi.fn(async () => ({ app: { ...app, key: "d~new~sales", scope: "draft" as const }, prompt: "Requested changes: " }));
    const send = vi.fn();
    vi.stubGlobal("window", { unskilled: { createThread, updateThread: async (_id: string, patch: Partial<Thread>) => ({ ...thread, ...patch }), prepareAppEdit, send } });
    useStore.setState({ selectedProjectId: "p", projects: [{ id: "p", path: "/project", name: "Project", createdAt: 0 }], threadKind: "design", draft: {}, lastAgent: "codex", libraryTab: "apps" });
    expect(await useStore.getState().editApp(app)).toBe("new");
    expect(createThread).toHaveBeenCalledWith("p", "codex", { kind: "chat", preset: "creator" });
    expect(prepareAppEdit).toHaveBeenCalledWith("g~sales", "new");
    expect(send).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({ threadKind: "creator", selectedThreadId: "new", libraryTab: null, composerDraft: { text: "Requested changes: " }, appOpen: { key: "d~new~sales" } });
  });

  it("shows a copy failure and leaves the Library open", async () => {
    vi.stubGlobal("window", { unskilled: { createThread: async () => thread, updateThread: async () => thread, prepareAppEdit: async () => { throw new Error("Invalid app files"); } } });
    useStore.setState({ selectedProjectId: "p", projects: [{ id: "p", path: "/project", name: "Project", createdAt: 0 }], libraryTab: "apps" });
    expect(await useStore.getState().editApp(app)).toBeNull();
    expect(useStore.getState().libraryTab).toBe("apps");
    expect(useStore.getState().notice).toContain("Invalid app files");
  });

  it("opens an app at 900px without touching the pane layout (it is a modal, not a panel)", () => {
    const setPaneLayout = vi.fn();
    vi.stubGlobal("window", { innerWidth: 900 });
    useStore.setState({ setPaneLayout, inspectorOpen: false, appOpen: null });
    useStore.getState().openApp(app);
    expect(setPaneLayout).not.toHaveBeenCalled();
    expect(useStore.getState()).toMatchObject({ inspectorOpen: false, appOpen: app });
  });

  it("keeps the selected thread's engine/model for Edit, without copying its full-access permission", async () => {
    const createThread = vi.fn(async () => thread);
    const updateThread = vi.fn(async (_id: string, patch: Partial<Thread>) => ({ ...thread, ...patch }));
    vi.stubGlobal("window", { unskilled: { createThread, updateThread, prepareAppEdit: async () => ({ app: { ...app, scope: "draft", key: "d~new~sales" }, prompt: "Edit" }) } });
    useStore.setState({ selectedProjectId: "p", projects: [{ id: "p", path: "/project", name: "P", createdAt: 0 }], selectedThreadId: "old", threads: { p: [{ ...thread, id: "old", model: "preferred", permissionMode: "full" }] }, draft: {}, lastAgent: "claude" });
    await useStore.getState().editApp(app);
    expect(createThread).toHaveBeenCalledWith("p", "codex", { kind: "chat", preset: "creator" });
    expect(updateThread).toHaveBeenCalledWith("new", expect.objectContaining({ model: "preferred" }));
    expect(updateThread.mock.calls[0]![1]).not.toHaveProperty("permissionMode");
  });
});

describe("floating widget placement", () => {
  it("keeps a widget inside the window and stacks unmoved ones top right, under the header", async () => {
    const { clampPlace, defaultPlace } = await import("../src/renderer/src/components/PluginHost");
    const box = { width: 262, height: 182 };
    const view = { width: 900, height: 700 };
    expect(clampPlace({ x: 2000, y: -50 }, box, view)).toEqual({ x: 900 - 262 - 12, y: 12 });
    expect(defaultPlace(0, [box], view)).toEqual({ x: 900 - 262 - 16, y: 58 });
    // Side by side, no overlap: the second sits left of the first with a gap.
    const two = [box, { width: 182, height: 122 }];
    expect(defaultPlace(1, two, view)).toEqual({ x: 900 - 16 - 262 - 12 - 182, y: 58 });
    // No room left in the row: a new row under the tallest of the first.
    const narrow = { width: 400, height: 700 };
    expect(defaultPlace(1, two, narrow)).toEqual({ x: 400 - 16 - 182, y: 58 + 182 + 12 });
    expect(clampPlace({ x: 100, y: 100 }, { width: 2000, height: 2000 }, view)).toEqual({ x: 12, y: 12 });
  });
});

describe("draft reloads", () => {
  it("updates a shown floating draft's title and size in place, and moves it to the modal when its placement changes", () => {
    const draft = { ...app, key: "d~t1~water", scope: "draft" as const, placement: "floating" as const, size: { width: 260, height: 150 }, title: "Focus timer" };
    useStore.setState({ appOpen: null, surfaceDrafts: [draft], surfaceFocus: null, appReloads: {} });
    const fresh = { ...draft, title: "Water", size: { width: 180, height: 90 } };
    useStore.getState().apply({ type: "app-reload", key: draft.key, app: fresh });
    expect(useStore.getState()).toMatchObject({ surfaceDrafts: [fresh], surfaceFocus: null, appOpen: null, appReloads: { [draft.key]: 1 } });
    const modal = { ...fresh, placement: undefined, size: undefined };
    useStore.getState().apply({ type: "app-reload", key: draft.key, app: modal });
    expect(useStore.getState()).toMatchObject({ surfaceDrafts: [], appOpen: modal });
    useStore.getState().apply({ type: "app-reload", key: "d~t1~other", app: { ...modal, key: "d~t1~other" } });
    expect(useStore.getState().appOpen).toEqual(modal);
  });
});

describe("Creator toggle", () => {
  it("flips a new thread's kind, and leaves an open thread of the other kind for a fresh draft", async () => {
    const selectThread = vi.fn(async () => {});
    useStore.setState({ threadKind: "chat", selectedThreadId: null, selectThread });
    await useStore.getState().toggleCreator();
    expect(useStore.getState().threadKind).toBe("creator");
    expect(selectThread).not.toHaveBeenCalled();
    useStore.setState({ selectedProjectId: "p", selectedThreadId: "c1", threads: { p: [{ ...thread, id: "c1", preset: "creator" }] } });
    await useStore.getState().toggleCreator();
    expect(useStore.getState().threadKind).toBe("chat");
    expect(selectThread).toHaveBeenCalledWith(null);
    useStore.setState({ threadKind: "design" });
    await useStore.getState().toggleCreator();
    expect(useStore.getState().threadKind).toBe("design");
  });
});

describe("sidebar apps", () => {
  it("lists favourites first (oldest star first), then recently opened, at most three, never off or drafts", async () => {
    const { sidebarApps } = await import("../src/renderer/src/plugins");
    const mk = (key: string, extra: Partial<AppInfo> = {}): AppInfo => ({ ...app, key, name: key, title: key, ...extra });
    const list = [mk("g~a"), mk("g~b", { favorite: 20 }), mk("g~c"), mk("g~d", { favorite: 10 }), mk("g~e", { enabled: false, favorite: 1 }), mk("d~t~f", { scope: "draft" })];
    expect(sidebarApps(list, { "g~c": 5, "g~a": 2 }).map((a) => a.key)).toEqual(["g~d", "g~b", "g~c"]);
    expect(sidebarApps(list, {}).map((a) => a.key)).toEqual(["g~d", "g~b", "g~a"]);
  });
});
