import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppChecker, type CheckWindow, CHECK_HOST_URL, checkHostHtml } from "../src/main/apps/check";
import { AppRegistry, appDraftsDir, decodeAppKey, encodeAppKey, projectAppsDir, readAppFiles } from "../src/main/apps/registry";
import { serveApp } from "../src/main/apps/serve";
import { DraftWatcher } from "../src/main/apps/watch";
import { chatsRoot } from "../src/main/chats";
import { CREATOR_APP_CHECK_TOOL, CREATOR_APP_PREVIEW_TOOL, CREATOR_CONNECTOR_TEST_TOOL, creatorAppTools, shapeOf } from "../src/main/creator/app-tools";
import { CREATOR_PROPOSE_TOOL, creatorTools } from "../src/main/creator/tools";
import { Store } from "../src/main/db";
import { ExtensionService } from "../src/main/extensions/install";
import { validateProposal } from "../src/main/extensions/manifest";
import { ExtensionStore } from "../src/main/extensions/store";
import type { McpToolInfo } from "../src/main/mcp/servers";
import { APP_THEME_DEFAULTS, APP_THEME_TOKENS } from "../src/shared/apps";
import type { AppInfo, ExtensionAppSummary } from "../src/shared/types";

const dirs: string[] = [];
const stores: Store[] = [];
const makeTemp = () => {
  const d = mkdtempSync(join(tmpdir(), "creator-apps-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  // Windows cannot remove an open SQLite file.
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const manifest = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, title: "Sales", description: "Revenue and orders.", grants: [{ server: "shop", tools: ["sales_summary", "refund_order"] }], ...extra });

function writeDraft(dir: string, name: string, html = "<!doctype html><h1>Sales</h1><script src=\"app.js\"></script>", js = "console.log(1)") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.json"), manifest(name));
  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, "app.js"), js);
}

function setup() {
  const root = makeTemp();
  const userData = join(root, "userData");
  const projectDir = join(root, "project");
  mkdirSync(userData, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const cRoot = chatsRoot(userData);
  mkdirSync(cRoot, { recursive: true });
  const store = new Store(join(userData, "app.db"));
  stores.push(store);
  const extensions = new ExtensionStore(store.sql);
  const project = store.addProject(projectDir);
  const thread = store.createThread(project.id, "codex", "m", "ask", "chat", null, null, "creator");
  const draftsDir = appDraftsDir(projectDir);
  const registry = new AppRegistry({
    globalDir: join(userData, "apps"),
    projectPath: (id) => (id === project.id ? projectDir : null),
    draftsDir: (tid) => (tid === thread.id ? draftsDir : null),
  });
  const notices: string[] = [];
  const changes: { key: string; removed: boolean }[] = [];
  const service = new ExtensionService({
    extensions,
    projectOf: (id) => {
      try {
        return store.getProject(id);
      } catch {
        return null;
      }
    },
    allProjects: () => store.listProjects(),
    threadProjectId: (tid) => store.getThread(tid).projectId,
    chatsRoot: cRoot,
    skillDirs: () => ({ projectCubiq: join(projectDir, ".cubiq", "skills"), harness: join(userData, "skills") }),
    bundledSkillNames: () => [],
    invalidateSkills: () => {},
    listMcpNames: () => [],
    saveMcp: async () => {},
    removeMcp: vi.fn(async () => {}),
    mcpFile: () => join(userData, "mcp.json"),
    emitNotice: (_t, text) => notices.push(text),
    appsDir: (p) => (p ? projectAppsDir(p) : join(userData, "apps")),
    toolAccess: (_pid, _server, tool) => (tool === "sales_summary" ? "read" : tool === "refund_order" ? "write" : "unknown"),
    appsChanged: (c) => changes.push(c),
  });
  return { root, userData, projectDir, store, extensions, project, thread, draftsDir, registry, service, notices, changes };
}

function stageApp(env: ReturnType<typeof setup>, scope: "project" | "global", files: { path: string; content: string }[]) {
  const s = scope === "project" ? ({ kind: "project", projectId: env.project.id } as const) : ({ kind: "global" } as const);
  const check = validateProposal({ kind: "app", name: "sales", files }, { scope: s });
  if (!check.ok) throw new Error(check.errors.join("; "));
  return env.extensions.stage({ threadId: env.thread.id, scope: check.proposal.scope, draft: check.proposal.draft, digest: check.proposal.digest });
}

const appFiles = (html = "<!doctype html><h1>Sales</h1>") => [
  { path: "app.json", content: manifest("sales") },
  { path: "index.html", content: html },
];

describe("app drafts in the registry", () => {
  it("round-trips draft keys and keeps drafts out of the installed list", () => {
    const env = setup();
    expect(decodeAppKey(`d~${env.thread.id}~sales`)).toEqual({ scope: "draft", threadId: env.thread.id, name: "sales" });
    expect(encodeAppKey({ scope: "draft", threadId: "t1", name: "x" })).toBe("d~t1~x");
    expect(decodeAppKey("d~t1~Bad_Name")).toBeNull();
    writeDraft(join(env.draftsDir, "sales"), "sales");
    const key = `d~${env.thread.id}~sales`;
    expect(env.registry.info(key)).toMatchObject({ scope: "draft", title: "Sales", url: `cubiq-app://a/${encodeURIComponent(key)}/index.html` });
    expect(env.registry.list(env.project.id)).toEqual([]);
    // Another thread's key names nothing.
    expect(env.registry.info("d~other~sales")).toBeNull();
  });

  it("re-reads a draft's manifest on every request (its entry page may appear after app.json)", () => {
    const env = setup();
    const dir = join(env.draftsDir, "sales");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.json"), manifest("sales"));
    const key = `d~${env.thread.id}~sales`;
    expect(env.registry.manifest(key)).toBeNull();
    writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
    expect(env.registry.manifest(key)?.title).toBe("Sales");
  });

  it("reads an app folder as text files, skipping dot entries and refusing symlinks", () => {
    const root = makeTemp();
    writeDraft(root, "sales");
    writeFileSync(join(root, ".DS_Store"), "x");
    writeFileSync(join(root, "secret.txt"), "s");
    symlinkSync(join(root, "secret.txt"), join(root, "link.txt"));
    const r = readAppFiles(root);
    expect(r.files.map((f) => f.path)).toEqual(["app.js", "app.json", "index.html", "secret.txt"]);
    expect(r.errors).toEqual(['"link.txt" is a symlink; apps hold plain files only.']);
  });
});

describe("installing app proposals", () => {
  it("installs a staged app with hashes and announces it", async () => {
    const env = setup();
    const p = stageApp(env, "global", appFiles());
    const view = await env.service.install(p.id);
    expect(view.status).toBe("installed");
    const dest = join(env.userData, "apps", "sales");
    expect(readFileSync(join(dest, "index.html"), "utf-8")).toBe("<!doctype html><h1>Sales</h1>");
    const inst = env.extensions.installs().find((i) => i.kind === "app")!;
    expect(inst.files.find((f) => f.path === "index.html")!.sha256).toBe(sha("<!doctype html><h1>Sales</h1>"));
    expect(env.changes).toEqual([{ key: "g~sales", removed: false }]);
    expect(env.notices.at(-1)).toContain('Installed app "sales"');
    expect(env.registry.list(env.project.id).map((a) => a.name)).toEqual(["sales"]);
  });

  it("offers no project picker for apps and installs even a project-scoped one globally", async () => {
    const env = setup();
    const p = stageApp(env, "project", appFiles());
    expect(env.service.getProposalView(p.id)!.projectChoice).toBeNull();
    const v = await env.service.install(p.id, "project");
    expect(v.status).toBe("installed");
    expect(v.scope).toEqual({ kind: "global" });
    expect(existsSync(join(env.userData, "apps", "sales", "app.json"))).toBe(true);
    expect(existsSync(join(projectAppsDir(env.projectDir), "sales"))).toBe(false);
  });

  it("shows grants with their access, then updates in place with a per-file diff", async () => {
    const env = setup();
    const first = stageApp(env, "global", appFiles());
    const v1 = env.service.getProposalView(first.id)!;
    const d1 = v1.draft as ExtensionAppSummary;
    expect(d1.grants).toEqual([
      { server: "shop", tool: "refund_order", access: "write" },
      { server: "shop", tool: "sales_summary", access: "read" },
    ]);
    expect(d1.update).toBe(false);
    expect(d1.draftKey).toBe(`d~${env.thread.id}~sales`);
    await env.service.install(first.id);

    const second = stageApp(env, "global", [{ path: "app.json", content: manifest("sales") }, { path: "index.html", content: "<h1>v2</h1>" }, { path: "app.js", content: "1" }]);
    const d2 = env.service.getProposalView(second.id)!.draft as ExtensionAppSummary;
    expect(d2.update).toBe(true);
    expect(d2.files).toEqual([
      { path: "app.js", bytes: 1, change: "added" },
      { path: "app.json", bytes: Buffer.byteLength(manifest("sales")) },
      { path: "index.html", bytes: 11, change: "changed" },
    ]);
    const v2 = await env.service.install(second.id);
    expect(v2.status).toBe("installed");
    expect(readFileSync(join(env.userData, "apps", "sales", "index.html"), "utf-8")).toBe("<h1>v2</h1>");
    expect(env.extensions.installs().filter((i) => i.kind === "app")).toHaveLength(1);
    expect(env.notices.at(-1)).toContain('Updated app "sales"');
    // No staging folders left behind.
    expect(readdirNames(join(env.userData, "apps"))).toEqual(["sales"]);
  });

  it("refuses to update an app whose files were edited after install, and keeps it as it was", async () => {
    const env = setup();
    await env.service.install(stageApp(env, "global", appFiles()).id);
    writeFileSync(join(env.userData, "apps", "sales", "index.html"), "hand edit");
    const v = await env.service.install(stageApp(env, "global", appFiles("<h1>v2</h1>")).id);
    expect(v.status).toBe("failed");
    expect(v.error).toContain("was modified after installation");
    expect(readFileSync(join(env.userData, "apps", "sales", "index.html"), "utf-8")).toBe("hand edit");
  });

  it("refuses a name taken by a folder CubiQ didn't install", async () => {
    const env = setup();
    mkdirSync(join(env.userData, "apps", "sales"), { recursive: true });
    const v = await env.service.install(stageApp(env, "global", appFiles()).id);
    expect(v.status).toBe("failed");
    expect(v.error).toContain('An app named "sales" already exists');
  });

  it("refuses an update that would discard an unrecorded file or restore a user's deletion", async () => {
    const env = setup();
    await env.service.install(stageApp(env, "global", appFiles()).id);
    const dir = join(env.userData, "apps", "sales");
    writeFileSync(join(dir, "notes.txt"), "User notes");
    const added = await env.service.install(stageApp(env, "global", appFiles("<h1>v2</h1>")).id);
    expect(added.error).toContain("added after installation");
    expect(readFileSync(join(dir, "notes.txt"), "utf-8")).toBe("User notes");
    rmSync(join(dir, "notes.txt"));
    rmSync(join(dir, "index.html"));
    const removed = await env.service.install(stageApp(env, "global", appFiles()).id);
    expect(removed.error).toContain("removed after installation");
    expect(existsSync(join(dir, "index.html"))).toBe(false);
  });

  it("uninstalls an app's verified files without touching connectors", async () => {
    const env = setup();
    await env.service.install(stageApp(env, "global", appFiles()).id);
    const inst = env.extensions.installs().find((i) => i.kind === "app")!;
    await env.service.uninstall(inst.id);
    expect(existsSync(join(env.userData, "apps", "sales"))).toBe(false);
    expect(env.extensions.installs()).toEqual([]);
    expect(env.changes.at(-1)).toEqual({ key: "g~sales", removed: true });
  });

  it("refuses a proposal whose app.json doesn't match its name", () => {
    const r = validateProposal({ kind: "app", name: "other", files: appFiles() }, { scope: { kind: "global" } });
    expect(r.ok).toBe(false);
  });
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}

function toolsFor(env: ReturnType<typeof setup>, over: Partial<Parameters<typeof creatorAppTools>[0]> = {}) {
  const opened: AppInfo[] = [];
  const watched: string[] = [];
  const shopTools: McpToolInfo[] = [
    { name: "sales_summary", description: "Revenue per day.", inputSchema: { type: "object", properties: { days: { type: "number" } }, required: ["days"] }, readOnly: true },
    { name: "refund_order", description: "Refund.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  ];
  const callReadOnly = vi.fn(async () => ({ text: "", isError: false, data: { currency: "USD", days: [{ date: "11-01", revenue: 10, orders: 2 }] } }));
  const tools = creatorAppTools(
    {
      templatesDir: resolve("resources/creator/templates"),
      draftsDir: (tid) => (tid === env.thread.id ? env.draftsDir : null),
      threadOf: (id) => env.store.getThread(id),
      appInfo: (key) => env.registry.info(key),
      openPreview: (_t, a) => opened.push(a),
      watch: (key) => watched.push(key),
      check: async () => ({ ok: true, errors: [], calls: [{ call: "shop.sales_summary", status: "ok", ms: 3 }], empty: false, text: "Sales", size: { width: 900, height: 400 }, timedOut: false, png: Buffer.from("png") }),
      takeImage: () => true,
      connectorTools: async (_t, server) => (server === "shop" ? { ok: true, tools: shopTools } : { ok: false, error: "No enabled connector" }),
      callReadOnly,
      ...over,
    },
    env.thread.id,
  );
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { byName, opened, watched, callReadOnly };
}

describe("Creator app tools", () => {
  it("seeds a draft from the dashboard template, renames it, opens it and watches it", async () => {
    const env = setup();
    const { byName, opened, watched } = toolsFor(env);
    const r = await byName[CREATOR_APP_PREVIEW_TOOL]!.run({ name: "my-sales", template: "dashboard" });
    expect(r.isError).not.toBe(true);
    const out = JSON.parse(r.text);
    expect(out).toMatchObject({ path: join(env.draftsDir, "my-sales"), seeded: "dashboard", shown: true });
    expect(JSON.parse(readFileSync(join(env.draftsDir, "my-sales", "app.json"), "utf-8")).name).toBe("my-sales");
    expect(opened.map((a) => a.key)).toEqual([`d~${env.thread.id}~my-sales`]);
    expect(watched).toEqual([`d~${env.thread.id}~my-sales`]);
  });

  it("reports a broken draft instead of showing it, and won't seed in Plan mode", async () => {
    const env = setup();
    const { byName, opened } = toolsFor(env);
    const dir = join(env.draftsDir, "sales");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.json"), manifest("sales"));
    const r = await byName[CREATOR_APP_PREVIEW_TOOL]!.run({ name: "sales" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).errors.join(" ")).toContain('"entry"');
    expect(opened).toEqual([]);
    env.store.updateThread(env.thread.id, { permissionMode: "plan" });
    const plan = await byName[CREATOR_APP_PREVIEW_TOOL]!.run({ name: "fresh", template: "dashboard" });
    expect(plan.isError).toBe(true);
    expect(existsSync(join(env.draftsDir, "fresh"))).toBe(false);
  });

  it("checks a draft and attaches the screenshot only when the image budget allows", async () => {
    const env = setup();
    writeDraft(join(env.draftsDir, "sales"), "sales");
    const withImage = await toolsFor(env).byName[CREATOR_APP_CHECK_TOOL]!.run({ name: "sales" });
    expect(JSON.parse(withImage.text)).toMatchObject({ ok: true, calls: [{ call: "shop.sales_summary", status: "ok" }] });
    expect(withImage.imagePng).toBe(Buffer.from("png").toString("base64"));
    const check = vi.fn(async () => ({ ok: true, errors: [], calls: [], empty: false, text: "", size: { width: 0, height: 0 }, timedOut: false }));
    const noImage = await toolsFor(env, { takeImage: () => false, check }).byName[CREATOR_APP_CHECK_TOOL]!.run({ name: "sales" });
    expect(check).toHaveBeenCalledWith(`d~${env.thread.id}~sales`, expect.stringContaining("cubiq-app://a/"), { scheme: "light", screenshot: false });
    expect(noImage.imagePng).toBeUndefined();
    expect(noImage.text).toContain("No screenshot");
  });

  it("lists a connector's tools and runs only read-only ones", async () => {
    const env = setup();
    const { byName, callReadOnly } = toolsFor(env);
    const list = JSON.parse((await byName[CREATOR_CONNECTOR_TEST_TOOL]!.run({ server: "shop" })).text);
    expect(list.tools).toEqual([
      { name: "sales_summary", readOnly: true, description: "Revenue per day.", inputs: [{ name: "days", type: "number", required: true }] },
      { name: "refund_order", readOnly: false, description: "Refund.", inputs: [{ name: "id", type: "string" }] },
    ]);
    const refused = await byName[CREATOR_CONNECTOR_TEST_TOOL]!.run({ server: "shop", tool: "refund_order", args: { id: "1" } });
    expect(refused.isError).toBe(true);
    expect(callReadOnly).not.toHaveBeenCalled();
    const ran = JSON.parse((await byName[CREATOR_CONNECTOR_TEST_TOOL]!.run({ server: "shop", tool: "sales_summary", args: { days: 7 } })).text);
    expect(ran.shape).toEqual({ currency: "string", days: { array: 1, of: { date: "string", revenue: "number", orders: "number" } } });
    expect(ran.appGets).toContain("structured");
    expect((await byName[CREATOR_CONNECTOR_TEST_TOOL]!.run({ server: "nope" })).isError).toBe(true);
  });

  it("creator_propose kind app stages the draft folder's files, not text the model retypes", async () => {
    const env = setup();
    writeDraft(join(env.draftsDir, "sales"), "sales");
    const emitted: string[] = [];
    const tools = creatorTools(
      {
        creatorDir: resolve("resources/creator"),
        bundledSkillsDir: resolve("resources/skills"),
        chatsRoot: null,
        threadOf: (id) => env.store.getThread(id),
        projectOf: (id) => env.store.getProject(id),
        cwdOf: () => env.projectDir,
        skillsForProject: () => ({ skills: [] }) as never,
        mcpOverview: () => ({ builtIn: { name: "cubiq", active: true, tools: [] }, servers: [], project: null, external: [], file: "" }),
        extensions: env.extensions,
        emitProposal: (_t, id) => emitted.push(id),
        draftsDir: (tid) => (tid === env.thread.id ? env.draftsDir : null),
      },
      env.thread.id,
    );
    const propose = tools.find((t) => t.name === CREATOR_PROPOSE_TOOL)!;
    // Asked for the project: apps still stage globally.
    const r = await propose.run({ scope: "project", kind: "app", name: "sales" });
    expect(r.isError).not.toBe(true);
    const stored = env.extensions.get(JSON.parse(r.text).proposalId)!;
    expect(stored.scope).toEqual({ kind: "global" });
    expect(stored.draft.kind).toBe("app");
    expect((stored.draft as { files: { path: string }[] }).files.map((f) => f.path)).toEqual(["app.js", "app.json", "index.html"]);
    expect(emitted).toHaveLength(1);
    const missing = await propose.run({ scope: "project", kind: "app", name: "nothing" });
    expect(missing.isError).toBe(true);
  });

  it("describes a value's shape without its data", () => {
    expect(shapeOf({ a: [1, 2], b: null, c: { d: "x" } })).toEqual({ a: { array: 2, of: "number" }, b: "null", c: { d: "string" } });
  });
});

describe("app check", () => {
  it("serves the host page with a CSP that frames only app pages", async () => {
    const r = serveApp(CHECK_HOST_URL, { appRoot: () => null, bridge: "" });
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Security-Policy")).toContain("frame-src cubiq-app://a/");
    expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await r.text()).toContain('sandbox="allow-scripts"');
    expect(checkHostHtml()).not.toContain("allow-same-origin");
  });

  /** A fake host page: the app makes one read call and one write call, then logs an error. */
  function fakeWindow(script: { calls: { server: string; tool: string }[]; logs?: { level: "error" | "warn"; message: string }[]; text?: string; neverLoads?: boolean }) {
    const replies: { id: number; body: unknown }[] = [];
    let drained = false;
    const evaluated: string[] = [];
    const win: CheckWindow = {
      load: async () => {},
      evaluate: async (s) => {
        evaluated.push(s);
        if (s.startsWith("window.__cq.drain")) {
          if (drained) return { queue: [], logs: [], loaded: !script.neverLoads, ready: true, droppedLogs: 0 };
          drained = true;
          return { queue: script.calls.map((c, i) => ({ cubiqApp: 1, id: i + 1, op: "call", ...c, args: {} })), logs: script.logs ?? [], loaded: !script.neverLoads, ready: true, droppedLogs: 0 };
        }
        const m = /^window\.__cq\.reply\((\d+), ([\s\S]*)\)$/.exec(s);
        if (m) replies.push({ id: Number(m[1]), body: JSON.parse(m[2]!) });
        return true;
      },
      evaluateApp: async () => ({ text: script.text ?? "", chars: (script.text ?? "").length, media: 0, width: 900, height: 500 }),
      capture: async () => Buffer.from("png"),
      destroy: vi.fn(),
    };
    return { win, replies, evaluated };
  }

  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("runs read calls, never runs writes, collects errors and destroys its window", async () => {
    const { win, replies, evaluated } = fakeWindow({
      calls: [{ server: "shop", tool: "sales_summary" }, { server: "shop", tool: "refund_order" }],
      logs: [{ level: "error", message: "TypeError: x is undefined" }],
      text: "Sales revenue 1,240 orders 31",
    });
    const call = vi.fn(async (_k: string, _s: string, tool: string) =>
      tool === "sales_summary" ? ({ ok: true, result: { total: 1 } } as const) : ({ ok: false, approval: { token: "t", server: "shop", tool, args: "{}" } } as const),
    );
    const c = clock();
    const checker = new AppChecker({ createWindow: () => win, call, storeGet: () => null, storeSet: () => ({ ok: true, result: null }), ...c });
    const r = await checker.check("d~t~sales", "cubiq-app://a/d~t~sales/index.html", { scheme: "dark", screenshot: true });
    expect(evaluated[0]).toContain(JSON.stringify(APP_THEME_DEFAULTS.dark.bg));
    expect(r.calls.map((x) => [x.call, x.status])).toEqual([
      ["shop.sales_summary", "ok"],
      ["shop.refund_order", "not-run"],
    ]);
    expect(replies.find((x) => x.id === 1)!.body).toEqual({ ok: true, result: { total: 1 } });
    expect(replies.find((x) => x.id === 2)!.body).toMatchObject({ ok: false });
    expect(r.errors).toEqual([{ level: "error", message: "TypeError: x is undefined" }]);
    expect(r.ok).toBe(false);
    expect(r.empty).toBe(false);
    expect(r.png?.toString()).toBe("png");
    expect(win.destroy).toHaveBeenCalled();
  });

  it("flags an empty page and a page that never loads", async () => {
    const empty = fakeWindow({ calls: [], text: "" });
    const c = clock();
    const deps = { call: vi.fn(), storeGet: () => null, storeSet: () => ({ ok: true as const, result: null }), ...c };
    const r1 = await new AppChecker({ ...deps, createWindow: () => empty.win }).check("g~a", "cubiq-app://a/g~a/index.html", { scheme: "light", screenshot: false });
    expect(r1).toMatchObject({ ok: false, empty: true, timedOut: false });
    expect(r1.png).toBeUndefined();
    const stuck = fakeWindow({ calls: [], text: "hello world, a page with text", neverLoads: true });
    const r2 = await new AppChecker({ ...deps, ...clock(), createWindow: () => stuck.win }).check("g~a", "cubiq-app://a/g~a/index.html", { scheme: "light", screenshot: false });
    expect(r2).toMatchObject({ ok: false, timedOut: true });
  });
});

describe("draft hot reload", () => {
  it("debounces changes into one reload and closes a thread's watches", async () => {
    vi.useFakeTimers();
    try {
      const reloads: string[] = [];
      const fires: Record<string, () => void> = {};
      const closed: string[] = [];
      const w = new DraftWatcher((k) => reloads.push(k), (dir, on) => {
        fires[dir] = on;
        return { close: () => closed.push(dir) };
      });
      w.watch("d~t1~a", "t1", "/x/a");
      w.watch("d~t1~a", "t1", "/x/a");
      fires["/x/a"]!();
      fires["/x/a"]!();
      vi.advanceTimersByTime(99);
      expect(reloads).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(reloads).toEqual(["d~t1~a"]);
      w.forgetThread("t1");
      expect(closed).toEqual(["/x/a"]);
      for (let i = 0; i < 10; i++) w.watch(`d~t2~a${i}`, "t2", `/y/${i}`);
      expect(w.size).toBe(8);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("app theme defaults", () => {
  it("match app.css for every token in both schemes", () => {
    const css = readFileSync(resolve("src/renderer/src/styles/app.css"), "utf-8").replace(/\r\n/g, "\n");
    // The base :root block (light) runs up to the dark media query; the explicit dark block is `:root[data-theme="dark"] {` on its own line.
    const light = css.slice(css.indexOf(":root {", css.indexOf(':root[data-theme="dark"] { color-scheme')), css.indexOf("@media (prefers-color-scheme: dark)"));
    const darkStart = css.indexOf(':root[data-theme="dark"] {\n');
    const dark = css.slice(darkStart, css.indexOf("\n}", darkStart));
    const value = (src: string, t: string) => new RegExp(`--${t}:\\s*([^;]+);`).exec(src)?.[1]?.trim();
    for (const t of APP_THEME_TOKENS) {
      expect(value(light, t), `light ${t}`).toBe(APP_THEME_DEFAULTS.light[t]);
      expect(value(dark, t), `dark ${t}`).toBe(APP_THEME_DEFAULTS.dark[t]);
    }
  });
});
