import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LiveUpdate, PlanDecision, ThreadEvent } from "../src/shared/types";
import { teamMemberProtocol, type ExpertDef } from "../src/shared/experts";
import type { AgentDriver, HarnessTool, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { CRITIQUE_ARTIFACT, PLAN_ARTIFACT } from "../src/shared/artifact-kind";
import { Store } from "../src/main/db";
import type { TurnDelta } from "../src/main/memory/extractor";
import { Service, titleFrom } from "../src/main/service";
import { normalizeUsage } from "../src/main/usage";
import { catalog, closeAfter, tempDir } from "./helpers";

function fakeDriver(script: (input: TurnInput) => Promise<void>): AgentDriver & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "fake",
    label: "Fake",
    defaultModel: "fake-1",
    capabilities: SAFE_DEFAULTS,
    skillsDelivery: { mode: "none" },
    skillCallPrefix: "skilled:",
    models: () => [{ id: "fake-1", label: "Fake 1" }],
    prompts,
    async runTurn(input) {
      prompts.push(input.prompt);
      await script(input);
    },
  };
}

function setup(script: (input: TurnInput) => Promise<void>) {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const updates: LiveUpdate[] = [];
  const driver = fakeDriver(script);
  const service = new Service(store, () => catalog(), [driver], (u) => updates.push(u));
  const project = store.addProject(tempDir());
  const thread = service.createThread(project.id);
  return { store, service, driver, updates, thread };
}

describe("Service.send", () => {
  it("stores the turn, names the thread, and remembers the session", async () => {
    const { store, service, thread, updates } = setup(async (input) => {
      input.onSession("session-1");
      input.onTextDelta("Hel");
      input.onEvent({ kind: "assistant-text", text: "Hello" });
    });
    await service.send({ threadId: thread.id, text: "Say hi" });
    expect(store.listEvents(thread.id).map((e) => e.event.kind)).toEqual(["user", "assistant-text"]);
    expect(store.getThread(thread.id)).toMatchObject({ title: "Say hi", sessionId: "session-1" });
    expect(updates.filter((u) => u.type === "running").map((u) => (u as { running: boolean }).running)).toEqual([true, false]);
    expect(service.isRunning(thread.id)).toBe(false);
  });

  it("stores an unchanged resend of this turn's todo list once, and the same list again in a new turn", async () => {
    const list = [{ content: "a", status: "in_progress" as const }];
    const { store, service, thread, updates } = setup(async (input) => {
      input.onEvent({ kind: "plan", entries: list });
      input.onEvent({ kind: "plan", entries: [...list] });
      input.onEvent({ kind: "plan", entries: [{ content: "a", status: "completed" }] });
      input.onEvent({ kind: "plan", entries: [{ content: "a", status: "completed" }] });
    });
    await service.send({ threadId: thread.id, text: "go" });
    expect(store.listEvents(thread.id).filter((e) => e.event.kind === "plan")).toHaveLength(2);
    expect(updates.filter((u) => u.type === "event" && u.stored.event.kind === "plan")).toHaveLength(2);
    await service.send({ threadId: thread.id, text: "again" });
    expect(store.listEvents(thread.id).filter((e) => e.event.kind === "plan")).toHaveLength(4);
  });

  it("nests a cubiq run_code script's calls under its own row, and only while the turn runs", async () => {
    let seen: { parent?: string; fallback?: string; other?: string } = {};
    const { store, service, thread } = setup(async (input) => {
      input.onEvent({ kind: "tool-use", toolUseId: "a", name: "mcp__cubiq__run_code", summary: "s", payload: { code: "return 1" } });
      input.onEvent({ kind: "tool-use", toolUseId: "b", name: "run_code", summary: "s", payload: { code: "return 2" } });
      seen = { parent: service.scriptParent(thread.id, "return 1"), fallback: service.scriptParent(thread.id, "return 3") };
      service.emitFromTool(thread.id, { kind: "tool-use", toolUseId: "a:1", name: "Read", summary: "x", parentId: "a" });
      input.onEvent({ kind: "tool-result", toolUseId: "b", isError: false, summary: "ok" });
      seen.other = service.scriptParent(thread.id, "return 2");
    });
    await service.send({ threadId: thread.id, text: "go" });
    // Exact code first; otherwise the newest open row; a finished row is no longer a parent.
    expect(seen).toEqual({ parent: "a", fallback: "b", other: "a" });
    expect(store.listEvents(thread.id).some((e) => e.event.kind === "tool-use" && e.event.parentId === "a")).toBe(true);
    // After the turn: no parent, and a late row is dropped.
    expect(service.scriptParent(thread.id, "return 1")).toBeUndefined();
    service.emitFromTool(thread.id, { kind: "tool-use", toolUseId: "late", name: "Read", summary: "x" });
    expect(store.listEvents(thread.id).some((e) => e.event.kind === "tool-use" && e.event.toolUseId === "late")).toBe(false);
  });

  it("refuses to start in a project folder that's gone, and says why", async () => {
    const { store, service, driver, thread, updates } = setup(async () => {});
    rmSync(store.getProject(thread.projectId).path, { recursive: true, force: true });
    await service.send({ threadId: thread.id, text: "hi" });
    const events = store.listEvents(thread.id).map((e) => e.event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error" });
    expect((events[0] as { message: string }).message).toContain("Project folder not found");
    expect(driver.prompts).toEqual([]);
    expect(updates.some((u) => u.type === "projects-changed")).toBe(true);
    expect(updates).toContainEqual({ type: "running", threadId: thread.id, running: false });
    expect(service.isRunning(thread.id)).toBe(false);
    await expect(service.send({ threadId: thread.id, text: "again" })).resolves.toBeUndefined();
  });

  it("passes the thread's context window to the driver, and a model change clears it", async () => {
    const seen: (number | null | undefined)[] = [];
    const { service, thread } = setup(async (input) => {
      seen.push(input.contextWindow);
    });
    service.updateThread(thread.id, { contextWindow: 872000 });
    await service.send({ threadId: thread.id, text: "one" });
    expect(service.updateThread(thread.id, { model: "other-model" }).contextWindow).toBeNull();
    await service.send({ threadId: thread.id, text: "two" });
    expect(seen).toEqual([872000, null]);
  });

  it("moves a thread pinned to a saved provider back to the agent's default model, with a notice", async () => {
    const seen: string[] = [];
    const { store, service, thread, updates } = setup(async (input) => {
      seen.push(input.model);
    });
    store.updateThread(thread.id, { model: "unskilled-th/deepseek" });
    await service.send({ threadId: thread.id, text: "go" });
    expect(seen).toEqual(["fake-1"]);
    expect(store.getThread(thread.id).model).toBe("fake-1");
    expect(updates).toContainEqual({ type: "thread", thread: expect.objectContaining({ id: thread.id, model: "fake-1" }) });
    const notices = store
      .listEvents(thread.id)
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: "notice" }> => e.kind === "notice")
      .map((e) => e.text);
    expect(notices).toContain("th is its own agent now. This thread is back on Fake's default model; pick th in the model picker to use it.");
  });

  it("switches from the model the last turn started with, not a later stored event's", async () => {
    const switches: { threadId: string; sessionId: string; from: string; to: string }[] = [];
    const { store, service, driver, thread } = setup(async (input) => {
      input.onSession("session-1");
      input.onEvent({ kind: "turn-start", turnId: "turn-1", agent: "fake", model: input.model });
      input.onEvent({ kind: "assistant-text", text: "ok" });
    });
    driver.setModel = async (req) => {
      switches.push(req);
      return "in-place";
    };
    await service.send({ threadId: thread.id, text: "one" });
    // The user picks B after the turn; the notice stored then already carries B.
    store.appendEvent(thread.id, { kind: "notice", text: "picked B" }, { agent: "fake", model: "m2", provider: null, instanceId: null });
    service.updateThread(thread.id, { model: "m2" });
    await service.send({ threadId: thread.id, text: "two" });

    expect(switches).toEqual([{ threadId: thread.id, sessionId: "session-1", from: "fake-1", to: "m2" }]);
  });

  it("says so when a model ends the turn without any reply", async () => {
    const turnEnd = { kind: "turn-end" as const, costUsd: null, inputTokens: 10, outputTokens: 0, durationMs: 5 };
    const silent = setup(async (input) => input.onEvent(turnEnd));
    await silent.service.send({ threadId: silent.thread.id, text: "hi" });
    const events = silent.store.listEvents(silent.thread.id).map((e) => e.event);
    expect(events.map((e) => e.kind)).toEqual(["user", "notice", "turn-end"]);
    expect(events[1]).toMatchObject({ kind: "notice", text: expect.stringMatching(/without a reply from fake-1/) });

    const replied = setup(async (input) => {
      input.onEvent({ kind: "assistant-text", text: "OK" });
      input.onEvent(turnEnd);
    });
    await replied.service.send({ threadId: replied.thread.id, text: "hi" });
    expect(replied.store.listEvents(replied.thread.id).map((e) => e.event.kind)).toEqual(["user", "assistant-text", "turn-end"]);
  });

  it("broadcasts live deltas without writing them to the store", async () => {
    const { store, service, thread, updates } = setup(async (input) => {
      input.onReasoningDelta?.({ itemId: "r1", text: "think", opaque: false });
      input.onTextDelta("x", "i1");
    });
    await service.send({ threadId: thread.id, text: "go" });
    expect(updates).toContainEqual({
      type: "delta",
      threadId: thread.id,
      delta: { kind: "reasoning-delta", itemId: "r1", text: "think", opaque: false },
    });
    expect(updates).toContainEqual({
      type: "delta",
      threadId: thread.id,
      delta: { kind: "text-delta", itemId: "i1", text: "x" },
    });
    expect(store.listEvents(thread.id).map((e) => e.event.kind)).toEqual(["user"]);
  });

  it("expands a user-invoked skill into the prompt", async () => {
    const { service, thread, driver } = setup(async () => {});
    await service.send({ threadId: thread.id, text: "ticket 2", skills: ["implement"] });
    expect(driver.prompts[0]).toContain('<skill name="implement"');
  });

  it("stores several skills on the user event, with no single skill field", async () => {
    const { store, service, thread } = setup(async () => {});
    await service.send({ threadId: thread.id, text: "ticket 2", skills: ["implement", "tdd"] });
    const user = store
      .listEvents(thread.id)
      .map((e) => e.event)
      .find((e): e is Extract<ThreadEvent, { kind: "user" }> => e.kind === "user");
    expect(user?.skills).toEqual(["implement", "tdd"]);
    expect(user && "skill" in user).toBe(false);
  });

  it("prepends a memory update to a resumed session's prompt, leaving the stored user event alone", async () => {
    const { store, service, driver, thread } = setup(async () => {});
    service.setMemoryUpdates(() => "<memory-update>X</memory-update>");
    store.updateThread(thread.id, { sessionId: "session-1" });
    await service.send({ threadId: thread.id, text: "Say hi" });
    expect(driver.prompts[0]!.startsWith("<memory-update>X</memory-update>\n\n")).toBe(true);
    const user = store
      .listEvents(thread.id)
      .map((e) => e.event)
      .find((e): e is Extract<ThreadEvent, { kind: "user" }> => e.kind === "user");
    expect(user?.text).toBe("Say hi");
  });

  it("leaves a new session's prompt unchanged, since it gets a fresh memory block anyway", async () => {
    const { service, driver, thread } = setup(async () => {});
    service.setMemoryUpdates(() => "<memory-update>X</memory-update>");
    await service.send({ threadId: thread.id, text: "Say hi" });
    expect(driver.prompts[0]).not.toContain("<memory-update>");
  });

  it("routes permission requests to the UI and back", async () => {
    let decision = "";
    const { service, thread, updates } = setup(async (input) => {
      decision = await input.requestPermission({ toolName: "Bash", summary: "ls", canAlwaysAllow: false });
    });
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    const req = updates.find((u) => u.type === "permission");
    expect(req).toBeDefined();
    service.respondPermission((req as Extract<LiveUpdate, { type: "permission" }>).request.requestId, "allow-once");
    await sending;
    expect(decision).toBe("allow-once");
  });

  it("takes a card down when its asker goes away, and a late answer changes nothing", async () => {
    let decision = "";
    const gone = new AbortController();
    const { service, thread, updates } = setup(async (input) => {
      decision = await input.requestPermission({ toolName: "Run", summary: "ls", canAlwaysAllow: false, signal: gone.signal });
    });
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    const req = updates.find((u) => u.type === "permission") as Extract<LiveUpdate, { type: "permission" }>;
    expect(req.request).not.toHaveProperty("signal");
    gone.abort();
    await sending;
    expect(decision).toBe("deny");
    expect(updates).toContainEqual({ type: "permission-withdrawn", requestId: req.request.requestId });
    service.respondPermission(req.request.requestId, "allow-once");
    expect(decision).toBe("deny");
  });

  it("denies pending permissions when interrupted", async () => {
    let decision = "";
    const { service, thread } = setup(async (input) => {
      decision = await input.requestPermission({ toolName: "Bash", summary: "ls", canAlwaysAllow: false });
    });
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    service.interrupt(thread.id);
    await sending;
    expect(decision).toBe("deny");
  });

  it("routes plan proposals to the UI and back, recording the decision and the mode", async () => {
    let decision: PlanDecision | null = null;
    const { service, thread, store, updates } = setup(async (input) => {
      decision = await input.requestPlanDecision({ plan: "# The plan" });
    });
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    const req = updates.find((u) => u.type === "plan-approval") as Extract<LiveUpdate, { type: "plan-approval" }>;
    expect(req).toBeDefined();
    expect(req.request.plan).toBe("# The plan");
    service.respondPlan(req.request.requestId, "auto");
    await sending;
    expect(decision).toBe("auto");
    expect(store.getThread(thread.id).permissionMode).toBe("auto-edit");
    const kinds = store.listEvents(thread.id).map((e) => e.event.kind);
    expect(kinds).toContain("plan-proposal");
    expect(kinds).toContain("plan-decision");
    expect(updates.some((u) => u.type === "plan-approval-done")).toBe(true);
  });

  it("keeps each plan round as the next version of the thread's plan artifact", async () => {
    const { service, thread, store, updates } = setup(async (input) => {
      await input.requestPlanDecision({ plan: "# Plan one" });
      await input.requestPlanDecision({ plan: "# Plan one" });
      await input.requestPlanDecision({ plan: "# Plan two" });
    });
    service.setArtifacts({
      addVersion: (threadId, path, sha, bytes, turnSeq) => store.addArtifactVersion(threadId, path, sha, bytes, turnSeq),
      listVersions: (threadId) => store.listArtifactVersions(threadId),
      writeBlob: (sha, content) => store.writeBlobBytes(sha, content),
      readBlob: (sha) => store.readBlobBytes(sha),
      gitHead: async () => null,
      preview: async () => ({ ok: false, error: "none" }),
      fileUrl: () => "",
    });
    const sending = service.send({ threadId: thread.id, text: "go" });
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(updates.filter((u) => u.type === "plan-approval")).toHaveLength(i + 1));
      const req = updates.filter((u) => u.type === "plan-approval")[i] as Extract<LiveUpdate, { type: "plan-approval" }>;
      service.respondPlan(req.request.requestId, { keep: "" });
    }
    await sending;
    // An unchanged round adds no version.
    expect(service.listArtifacts(thread.id)).toEqual([expect.objectContaining({ path: PLAN_ARTIFACT, kind: "md", versions: [expect.objectContaining({ version: 1 }), expect.objectContaining({ version: 2 })] })]);
    const latest = await service.readArtifact(thread.id, PLAN_ARTIFACT, null);
    expect(latest.ok && latest.text).toBe("# Plan two");
    const first = await service.readArtifact(thread.id, PLAN_ARTIFACT, 1);
    expect(first.ok && first.text).toBe("# Plan one");
  });

  it("asks for each turn's tools with the thread, so only a design thread can get the design tools", async () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const chatTools: HarnessTool[] = [];
    const designList: HarnessTool[] = [];
    const seen: string[] = [];
    const got: HarnessTool[][] = [];
    const driver = fakeDriver(async (input) => void got.push(input.tools));
    const service = new Service(store, () => catalog(), [driver], () => {}, (thread) => {
      seen.push(thread?.kind ?? "none");
      return thread?.kind === "design" ? designList : chatTools;
    });
    const project = store.addProject(tempDir());
    const chat = service.createThread(project.id);
    const design = service.createThread(project.id, undefined, "design");
    await service.send({ threadId: chat.id, text: "a" });
    await service.send({ threadId: design.id, text: "b" });
    expect(got[0]).toBe(chatTools);
    expect(got[1]).toBe(designList);
    expect(seen).not.toContain("none");
  });

  it("runs a design thread in Full whatever mode it has stored, and starts one in Full", async () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const modes: TurnInput["permissionMode"][] = [];
    const driver = fakeDriver(async (input) => void modes.push(input.permissionMode));
    const service = new Service(store, () => catalog(), [driver], () => {});
    const project = store.addProject(tempDir());
    const chat = service.createThread(project.id);
    const design = service.createThread(project.id, undefined, "design");
    expect(design.permissionMode).toBe("full");
    store.updateThread(design.id, { permissionMode: "ask" });
    await service.send({ threadId: chat.id, text: "a" });
    await service.send({ threadId: design.id, text: "b" });
    expect(modes).toEqual([chat.permissionMode, "full"]);
  });

  it("saves a design thread's critique as versions of its Critique artifact, and refuses a chat thread", () => {
    const { service, store, updates } = setup(async () => {});
    service.setArtifacts({
      addVersion: (threadId, path, sha, bytes, turnSeq) => store.addArtifactVersion(threadId, path, sha, bytes, turnSeq),
      listVersions: (threadId) => store.listArtifactVersions(threadId),
      writeBlob: (sha, content) => store.writeBlobBytes(sha, content),
      readBlob: (sha) => store.readBlobBytes(sha),
      gitHead: async () => null,
      preview: async () => ({ ok: false, error: "none" }),
      fileUrl: () => "",
    });
    const project = store.addProject(tempDir());
    const chat = service.createThread(project.id);
    const design = service.createThread(project.id, undefined, "design");
    expect(() => service.saveCritique(chat.id, "# no")).toThrow(/design thread/);
    expect(service.saveCritique(design.id, "# Round 1\n")).toEqual({ version: 1 });
    expect(service.saveCritique(design.id, "# Round 1\n")).toBeNull();
    expect(service.saveCritique(design.id, "# Round 2\n")).toEqual({ version: 2 });
    expect(service.listArtifacts(design.id)).toEqual([expect.objectContaining({ path: CRITIQUE_ARTIFACT, kind: "md" })]);
    expect(updates.filter((u) => u.type === "artifact-ready")).toEqual([
      { type: "artifact-ready", threadId: design.id, path: CRITIQUE_ARTIFACT, files: [CRITIQUE_ARTIFACT] },
      { type: "artifact-ready", threadId: design.id, path: CRITIQUE_ARTIFACT, files: [CRITIQUE_ARTIFACT] },
    ]);
  });

  it("promotes a design variant to index.html, saving the old and new index as versions, and refuses a chat thread", () => {
    const { service, store, updates } = setup(async () => {});
    service.setArtifacts({
      addVersion: (threadId, path, sha, bytes, turnSeq) => store.addArtifactVersion(threadId, path, sha, bytes, turnSeq),
      listVersions: (threadId) => store.listArtifactVersions(threadId),
      writeBlob: (sha, content) => store.writeBlobBytes(sha, content),
      readBlob: (sha) => store.readBlobBytes(sha),
      gitHead: async () => null,
      preview: async () => ({ ok: false, error: "none" }),
      fileUrl: () => "",
    });
    const project = store.addProject(tempDir());
    const chat = service.createThread(project.id);
    const design = service.createThread(project.id, undefined, "design");
    expect(() => service.promoteDesignVariant(chat.id, "variant-a.html")).toThrow(/design thread/);
    const root = service.designRoot(design.id)!;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), "<p>old</p>");
    writeFileSync(join(root, "variant-a.html"), "<p>new</p>");
    service.promoteDesignVariant(design.id, "variant-a.html");
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe("<p>new</p>");
    expect(existsSync(join(root, "variant-a.html"))).toBe(true);
    const path = `designs/${design.id.slice(0, 8)}/index.html`;
    const versions = store.listArtifactVersions(design.id).find((v) => v.path === path)!.versions;
    expect(versions).toHaveLength(2);
    expect(service.readDesignVersion(design.id, "index.html", 1)!.toString()).toBe("<p>old</p>");
    expect(updates.filter((u) => u.type === "artifact-ready")).toEqual([{ type: "artifact-ready", threadId: design.id, path, files: [path] }]);
    expect(() => service.promoteDesignVariant(design.id, "pricing.html")).toThrow("Not a variant.");
  });

  it("keeps a design thread's comments in its folder: add, resolve, mark sent, delete; refuses chat threads and unknown pages", () => {
    const { service, store } = setup(async () => {});
    const project = store.addProject(tempDir());
    const chat = service.createThread(project.id);
    const design = service.createThread(project.id, undefined, "design");
    expect(() => service.designComments(chat.id)).toThrow(/design thread/);
    const root = service.designRoot(design.id)!;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), "<p>x</p>");
    expect(service.designComments(design.id)).toEqual([]);
    const target = { id: "cta-buy", selector: "main > button", tag: "button", text: "Buy now" };
    expect(() => service.addDesignComment(design.id, { page: "nope.html", target, label: "button", text: "x" })).toThrow("No such page.");
    const [c] = service.addDesignComment(design.id, { page: "index.html", target, label: 'button "Buy now"', text: "  make it green " });
    expect(c).toMatchObject({ page: "index.html", text: "make it green", target });
    expect(existsSync(join(root, "comments.json"))).toBe(true);
    expect(service.updateDesignComment(design.id, c!.id, { sent: true })[0]!.sentAt).toBeTypeOf("number");
    expect(service.updateDesignComment(design.id, c!.id, { resolved: true })[0]!.resolved).toBe(true);
    expect(service.designComments(design.id)).toHaveLength(1);
    expect(service.deleteDesignComment(design.id, c!.id)).toEqual([]);
  });

  it("tells a design thread's agent its tier on the first turn and after a switch, never otherwise", async () => {
    const prompts: string[] = [];
    const { service, store } = setup(async (input) => {
      prompts.push(input.prompt);
    });
    const project = store.addProject(tempDir());
    const chat = service.createThread(project.id);
    // A thread on a fixed system, the project's own (an Auto thread hears its tier from design_set_direction instead).
    const fixed = join(project.path, ".agents", "design-systems", "fixed");
    mkdirSync(fixed, { recursive: true });
    writeFileSync(join(fixed, "index.md"), "---\ntype: design-system\nname: Fixed\n---\n");
    writeFileSync(join(fixed, "DESIGN.md"), "# Fixed\n");
    const design = service.createThread(project.id, undefined, "design", "project:fixed");
    expect(design.designSystem).toBe("project:fixed");
    expect(() => service.setPrototypeTier(chat.id, "quick")).toThrow(/design thread/);
    await service.send({ threadId: design.id, text: "one" });
    await service.send({ threadId: design.id, text: "two" });
    expect(service.setPrototypeTier(design.id, "quick").prototypeTier).toBe("quick");
    await service.send({ threadId: design.id, text: "three" });
    await service.send({ threadId: chat.id, text: "chat" });
    expect(prompts.map((p) => /Prototype tier: (\w+)/.exec(p)?.[1] ?? null)).toEqual(["Working", null, "Quick", null]);
  });

  it("lints the pages a design turn wrote and tells the next turn what's new, once", async () => {
    const prompts: string[] = [];
    const turnEnd = { kind: "turn-end" as const, costUsd: null, inputTokens: 10, outputTokens: 0, durationMs: 5 };
    let write: string | null = null;
    let stop = false;
    const { service, store } = setup(async (input) => {
      prompts.push(input.prompt);
      if (write) writeFileSync(join(service.designRoot(design.id)!, write), "<p>x</p>");
      if (stop) throw new Error("stopped");
      input.onEvent(turnEnd);
    });
    const project = store.addProject(tempDir());
    const design = service.createThread(project.id, undefined, "design");
    const chat = service.createThread(project.id);
    mkdirSync(service.designRoot(design.id)!, { recursive: true });
    const linted: string[][] = [];
    const finding = { rule: "slop" as const, selector: "p.kicker", detail: "eyebrow label above a heading" };
    service.setDesignAutoLint(async (_id, _root, rels) => {
      linted.push(rels);
      return rels.map((rel) => ({ rel, result: { findings: [finding, { rule: "spacing" as const, selector: "p", detail: "13px" }], skipped: [], scanned: 3 } }));
    });
    write = "index.html";
    await service.send({ threadId: design.id, text: "one" });
    write = null;
    await service.send({ threadId: design.id, text: "two" });
    write = "index.html";
    await service.send({ threadId: design.id, text: "three" });
    await service.send({ threadId: design.id, text: "four" });
    await service.send({ threadId: chat.id, text: "chat" });
    // A turn that fails after writing (no turn-end) is linted too.
    stop = true;
    finding.detail = "gradient text";
    await service.send({ threadId: design.id, text: "five" }).catch(() => {});
    stop = false;
    await service.send({ threadId: design.id, text: "six" });
    // Turn two wrote nothing: no lint after it, and the page turn one wrote isn't linted again.
    expect(linted).toEqual(Array(5).fill(["index.html"]));
    const notes = prompts.map((p) => /automatic design_lint[^]*\)$/.exec(p)?.[0] ?? null);
    expect(notes[0]).toBeNull();
    expect(notes[1]).toContain("- index.html [slop] p.kicker: eyebrow label above a heading");
    // Spacing stays with design_lint; the same finding, still there, isn't said again.
    expect(notes[1]).not.toContain("13px");
    expect(notes.slice(2, 6)).toEqual([null, null, null, null]);
    expect(notes[6]).toContain("- index.html [slop] p.kicker: gradient text");
  });

  it("sends one fix round when a design turn ends with new contrast findings, and none after a failed turn", async () => {
    const prompts: string[] = [];
    const turnEnd = { kind: "turn-end" as const, costUsd: null, inputTokens: 10, outputTokens: 0, durationMs: 5 };
    let stop = false;
    const { service, store } = setup(async (input) => {
      prompts.push(input.prompt);
      writeFileSync(join(service.designRoot(design.id)!, "index.html"), "<p>x</p>");
      if (stop) throw new Error("stopped");
      input.onEvent(turnEnd);
    });
    const project = store.addProject(tempDir());
    const design = service.createThread(project.id, undefined, "design");
    mkdirSync(service.designRoot(design.id)!, { recursive: true });
    const finding = { rule: "contrast" as const, selector: "p.muted", detail: "2.1:1 on #fff" };
    service.setDesignAutoLint(async (_id, _root, rels) => rels.map((rel) => ({ rel, result: { findings: [finding], skipped: [], scanned: 3 } })));
    await service.send({ threadId: design.id, text: "one" });
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 10_000 });
    await vi.waitFor(() => expect(service.isRunning(design.id)).toBe(false), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    // The fix round's own lint still finds the same contrast: it never asks for a second fix.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!).toMatch(/^CubiQ checked the pages you just wrote/);
    expect(prompts[1]!).toContain("- index.html [contrast] p.muted: 2.1:1 on #fff");
    expect(store.getThread(design.id).title).not.toContain("CubiQ checked");
    // A stopped turn gets no fix round: its new finding waits for the next turn's ordinary note.
    finding.detail = "1.9:1 on #fff";
    stop = true;
    await service.send({ threadId: design.id, text: "two" }).catch(() => {});
    await vi.waitFor(() => expect(service.isRunning(design.id)).toBe(false), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(prompts).toHaveLength(3);
    stop = false;
    await service.send({ threadId: design.id, text: "three" });
    await vi.waitFor(() => expect(service.isRunning(design.id)).toBe(false), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(prompts).toHaveLength(4);
    expect(prompts[3]!).toContain("automatic design_lint");
    expect(prompts[3]!).toContain("1.9:1 on #fff");
    expect(prompts[3]!).not.toMatch(/^CubiQ checked/);
  });

  it("sets an expert only on a thread with no messages yet", async () => {
    const { service, store } = setup(async () => {});
    const project = store.addProject(tempDir());
    const fresh = service.createThread(project.id);
    expect(service.setThreadExpert(fresh.id, "code-review").expertId).toBe("code-review");
    expect(service.setThreadExpert(fresh.id, null).expertId).toBeUndefined();
    const used = service.createThread(project.id);
    await service.send({ threadId: used.id, text: "hi" });
    expect(() => service.setThreadExpert(used.id, "code-review")).toThrow(/already has messages/);
  });

  it("gives a team thread's turns its members as subagents, and says once that this agent runs the team as one", async () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const inputs: TurnInput[] = [];
    const driver = fakeDriver(async (input) => {
      inputs.push(input);
      input.onSession(`s-${input.threadId}`);
    });
    const member = { id: "analyst", name: "Ana", profession: "Analyst", description: "Finds facts.", prompt: "Research.", skills: [] };
    const defs: Record<string, ExpertDef> = {
      crew: { id: "crew", kind: "team", name: "Crew", profession: "Lead", persona: "", category: "General", avatarText: "CR", description: "", tags: [], quickPrompts: [], prompt: "Lead.", skills: [], members: [member], source: "imported", version: "1" },
      solo: { id: "solo", kind: "agent", name: "Solo", profession: "Writer", persona: "", category: "General", avatarText: "SO", description: "", tags: [], quickPrompts: [], prompt: "Write.", skills: [], source: "builtin", version: "1" },
    };
    const service = new Service(store, () => catalog(), [driver], () => {}, undefined, undefined, undefined, undefined, null, { get: (id) => defs[id] ?? null });
    const project = store.addProject(tempDir());
    const team = service.createThread(project.id);
    service.setThreadExpert(team.id, "crew");
    await service.send({ threadId: team.id, text: "one" });
    await service.send({ threadId: team.id, text: "two" });
    expect(inputs[0]!.team).toEqual([{ id: "analyst", description: "Ana, Analyst: Finds facts.", prompt: `Research.\n\n${teamMemberProtocol("analyst")}` }]);
    expect(inputs[0]!.expert).toContain("## Your team");
    const notices = store.listEvents(team.id).filter((e) => e.event.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.event).toMatchObject({ text: expect.stringContaining("runs as one agent on Fake") });
    // A single expert: no team, no notice.
    const solo = service.createThread(project.id);
    service.setThreadExpert(solo.id, "solo");
    await service.send({ threadId: solo.id, text: "hi" });
    expect(inputs[2]!.team).toBeUndefined();
    expect(store.listEvents(solo.id).some((e) => e.event.kind === "notice")).toBe(false);
  });

  it("writes an in-place text edit into a design page with versions, and refuses when it isn't safe", () => {
    const { service, store, updates } = setup(async () => {});
    service.setArtifacts({
      addVersion: (threadId, path, sha, bytes, turnSeq) => store.addArtifactVersion(threadId, path, sha, bytes, turnSeq),
      listVersions: (threadId) => store.listArtifactVersions(threadId),
      writeBlob: (sha, content) => store.writeBlobBytes(sha, content),
      readBlob: (sha) => store.readBlobBytes(sha),
      gitHead: async () => null,
      preview: async () => ({ ok: false, error: "none" }),
      fileUrl: () => "",
    });
    const project = store.addProject(tempDir());
    const chat = service.createThread(project.id);
    const design = service.createThread(project.id, undefined, "design");
    expect(() => service.editDesignText(chat.id, "index.html", { id: "x", before: "a", after: "b" })).toThrow(/design thread/);
    const root = service.designRoot(design.id)!;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), `<main><button data-agent-id="cta-buy">Buy now</button><p>keep</p></main>`);
    service.editDesignText(design.id, "index.html", { id: "cta-buy", before: "Buy now", after: "Start free trial" });
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(`<main><button data-agent-id="cta-buy">Start free trial</button><p>keep</p></main>`);
    const path = `designs/${design.id.slice(0, 8)}/index.html`;
    expect(store.listArtifactVersions(design.id).find((v) => v.path === path)!.versions).toHaveLength(2);
    expect(updates.filter((u) => u.type === "artifact-ready")).toHaveLength(1);
    // The page moved on (stale before): refused, file untouched.
    expect(() => service.editDesignText(design.id, "index.html", { id: "cta-buy", before: "Buy now", after: "x" })).toThrow(/changed since/);
    expect(() => service.editDesignText(design.id, "missing.html", { id: "cta-buy", before: "a", after: "b" })).toThrow("No such page.");

    // Style edits: written with versions on Working, refused on Quick (that tier sends the change to the agent).
    service.editDesignStyle(design.id, "index.html", { id: "cta-buy", changes: [{ prop: "fontSize", value: "20px" }] });
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain(`<button data-agent-id="cta-buy" style="font-size: 20px">`);
    expect(store.listArtifactVersions(design.id).find((v) => v.path === path)!.versions).toHaveLength(3);
    service.setPrototypeTier(design.id, "quick");
    expect(() => service.editDesignStyle(design.id, "index.html", { id: "cta-buy", changes: [{ prop: "color", value: "red" }] })).toThrow(/Quick tier/);
    expect(() => service.editDesignStyle(chat.id, "index.html", { id: "cta-buy", changes: [] })).toThrow(/design thread/);
  });

  it("restores a design page version as the newest, keeping the current page as a version", () => {
    const { service, store } = setup(async () => {});
    service.setArtifacts({
      addVersion: (threadId, path, sha, bytes, turnSeq) => store.addArtifactVersion(threadId, path, sha, bytes, turnSeq),
      listVersions: (threadId) => store.listArtifactVersions(threadId),
      writeBlob: (sha, content) => store.writeBlobBytes(sha, content),
      readBlob: (sha) => store.readBlobBytes(sha),
      gitHead: async () => null,
      preview: async () => ({ ok: false, error: "none" }),
      fileUrl: () => "",
    });
    const project = store.addProject(tempDir());
    const chat = service.createThread(project.id);
    const design = service.createThread(project.id, undefined, "design");
    const root = service.designRoot(design.id)!;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), `<main><button data-agent-id="cta-buy">Buy now</button></main>`);
    service.editDesignText(design.id, "index.html", { id: "cta-buy", before: "Buy now", after: "Start" });
    const path = `designs/${design.id.slice(0, 8)}/index.html`;
    const versions = () => store.listArtifactVersions(design.id).find((v) => v.path === path)!.versions;
    expect(versions()).toHaveLength(2);
    service.restoreDesignVersion(design.id, "index.html", 1);
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(`<main><button data-agent-id="cta-buy">Buy now</button></main>`);
    // v2 (the page before) was already saved, so the restore adds only v3; v2 stays readable.
    expect(versions()).toHaveLength(3);
    expect(service.readDesignVersion(design.id, "index.html", 2)!.toString("utf8")).toContain("Start");
    expect(() => service.restoreDesignVersion(design.id, "index.html", 9)).toThrow(/No version 9/);
    expect(() => service.restoreDesignVersion(design.id, "missing.html", 1)).toThrow("No such page.");
    expect(() => service.restoreDesignVersion(chat.id, "index.html", 1)).toThrow(/design thread/);
  });

  it("saves a reference image into a design thread's refs folder and refuses a chat thread", () => {
    const { service, store } = setup(async () => {});
    const project = store.addProject(tempDir());
    const chat = service.createThread(project.id);
    const design = service.createThread(project.id, undefined, "design");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(() => service.saveDesignRef(chat.id, png)).toThrow(/design thread/);
    const dir = `designs/${design.id.slice(0, 8)}`;
    expect(service.saveDesignRef(design.id, png)).toBe(`${dir}/refs/ref-1.png`);
    expect(service.saveDesignRef(design.id, png)).toBe(`${dir}/refs/ref-2.png`);
    expect([...readFileSync(join(project.path, dir, "refs", "ref-1.png"))]).toEqual([...png]);
    expect(() => service.saveDesignRef(design.id, new Uint8Array([1, 2, 3]))).toThrow("Not an image");
  });

  it("keeps a design page's tweak values in the file, saving versions, and refuses other threads and pages", () => {
    const { service, store, updates } = setup(async () => {});
    service.setArtifacts({
      addVersion: (threadId, path, sha, bytes, turnSeq) => store.addArtifactVersion(threadId, path, sha, bytes, turnSeq),
      listVersions: (threadId) => store.listArtifactVersions(threadId),
      writeBlob: (sha, content) => store.writeBlobBytes(sha, content),
      readBlob: (sha) => store.readBlobBytes(sha),
      gitHead: async () => null,
      preview: async () => ({ ok: false, error: "none" }),
      fileUrl: () => "",
    });
    const project = store.addProject(tempDir());
    const chat = service.createThread(project.id);
    const design = service.createThread(project.id, undefined, "design");
    expect(() => service.keepDesignTweaks(chat.id, "index.html", {})).toThrow(/design thread/);
    const root = service.designRoot(design.id)!;
    mkdirSync(root, { recursive: true });
    const manifest = `<script type="application/json" id="cubiq-tweaks">{"tweaks":[{"id":"theme","type":"choice","options":["light","dusk"],"default":"light"}]}</script>`;
    writeFileSync(join(root, "index.html"), `<html data-theme="light"><head>${manifest}</head><body></body></html>`);
    expect(() => service.keepDesignTweaks(design.id, "missing.html", { theme: "dusk" })).toThrow("No such page.");
    expect(service.keepDesignTweaks(design.id, "index.html", { theme: "dusk" })).toBe(true);
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain(`<html data-theme="dusk">`);
    // Keeping the same values again changes nothing and adds no version.
    expect(service.keepDesignTweaks(design.id, "index.html", { theme: "dusk" })).toBe(false);
    const path = `designs/${design.id.slice(0, 8)}/index.html`;
    expect(store.listArtifactVersions(design.id).find((v) => v.path === path)!.versions).toHaveLength(2);
    expect(updates.filter((u) => u.type === "artifact-ready")).toEqual([{ type: "artifact-ready", threadId: design.id, path, files: [path] }]);
  });

  it("resolves a pending plan with keep-on-empty when interrupted", async () => {
    let decision: PlanDecision | null = null;
    const { service, thread } = setup(async (input) => {
      decision = await input.requestPlanDecision({ plan: "# The plan" });
    });
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    service.interrupt(thread.id);
    await sending;
    expect(decision).toEqual({ keep: "" });
  });

  it("refuses a second send while a turn runs", async () => {
    let release!: () => void;
    const { service, thread } = setup(() => new Promise<void>((r) => (release = r)));
    const first = service.send({ threadId: thread.id, text: "one" });
    await new Promise((r) => setTimeout(r, 10));
    await expect(service.send({ threadId: thread.id, text: "two" })).rejects.toThrow(/already running/);
    release();
    await first;
  });

  it("notifies the turn listener with the final answer and scrubbed user text", async () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const driver = fakeDriver(async (input) => {
      input.onEvent({ kind: "assistant-text", text: "Hello world" });
    });
    const service = new Service(store, () => catalog(), [driver], () => {}, undefined, undefined, undefined, () => ["super-secret-key"]);
    const project = store.addProject(tempDir());
    const thread = service.createThread(project.id);
    const seen: TurnDelta[] = [];
    service.setTurnListener((d) => seen.push(d));

    await service.send({ threadId: thread.id, text: "deploy with super-secret-key now" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      projectId: project.id,
      threadId: thread.id,
      agentId: "fake",
      user: "deploy with «redacted» now",
      answer: "Hello world",
    });
  });

  it("does not notify the turn listener when the turn was interrupted", async () => {
    const { service, thread } = setup(async (input) => {
      await new Promise((r) => setTimeout(r, 30));
      input.onEvent({ kind: "assistant-text", text: "late" });
    });
    const seen: TurnDelta[] = [];
    service.setTurnListener((d) => seen.push(d));

    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    service.interrupt(thread.id);
    await sending;
    expect(seen).toEqual([]);
  });

  it("marks the delta wroteMemory when the agent used the memory_write tool", async () => {
    const { service, thread } = setup(async (input) => {
      input.onEvent({ kind: "tool-use", toolUseId: "m1", name: "mcp__cubiq__memory_write", summary: "tabs" });
      input.onEvent({ kind: "assistant-text", text: "Noted." });
    });
    const seen: TurnDelta[] = [];
    service.setTurnListener((d) => seen.push(d));

    await service.send({ threadId: thread.id, text: "remember my tabs preference" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.wroteMemory).toBe(true);
  });

  it("leaves wroteMemory false when the agent wrote no memory", async () => {
    const { service, thread } = setup(async (input) => {
      input.onEvent({ kind: "assistant-text", text: "Done." });
    });
    const seen: TurnDelta[] = [];
    service.setTurnListener((d) => seen.push(d));

    await service.send({ threadId: thread.id, text: "just answer this" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.wroteMemory).toBeFalsy();
  });

  it("remembers allow-always per agent and re-asks after a switch", async () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const updates: LiveUpdate[] = [];
    const decisions: string[] = [];
    const driver = (id: string): AgentDriver => ({
      id,
      label: id.toUpperCase(),
      defaultModel: "m1",
      capabilities: SAFE_DEFAULTS,
      skillsDelivery: { mode: "none" },
      skillCallPrefix: "",
      models: () => [{ id: "m1", label: "M1" }],
      async runTurn(input) {
        decisions.push(await input.requestPermission({ toolName: "Run", summary: "npm test", canAlwaysAllow: true }));
      },
    });
    const service = new Service(store, () => catalog(), [driver("a"), driver("b")], (u) => updates.push(u));
    const project = store.addProject(tempDir());
    const thread = service.createThread(project.id);

    const first = service.send({ threadId: thread.id, text: "one" });
    await new Promise((r) => setTimeout(r, 10));
    const req = updates.find((u) => u.type === "permission") as Extract<LiveUpdate, { type: "permission" }>;
    service.respondPermission(req.request.requestId, "allow-always");
    await first;
    expect(updates.filter((u) => u.type === "permission")).toHaveLength(1);

    await service.send({ threadId: thread.id, text: "two" });
    expect(updates.filter((u) => u.type === "permission")).toHaveLength(1);
    expect(decisions[1]).toBe("allow-once");

    service.updateThread(thread.id, { agent: "b" });
    const third = service.send({ threadId: thread.id, text: "three" });
    // The new agent's first turn builds a catch-up (git reads) before it runs.
    await vi.waitFor(() => expect(updates.filter((u) => u.type === "permission")).toHaveLength(2), { timeout: 5000 });
    service.interrupt(thread.id);
    await third;
  });

  it("records an expected session rebuild as a non-miss on the next turn", async () => {
    let turns = 0;
    const { store, service, thread } = setup(async (input) => {
      turns++;
      if (turns === 2) input.onSessionRebuilt?.();
      input.onEvent({
        kind: "turn-end",
        costUsd: null,
        inputTokens: 100,
        outputTokens: 1,
        durationMs: 1,
        usage: normalizeUsage({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 50_000 }),
      });
    });
    await service.send({ threadId: thread.id, text: "one" });
    await service.send({ threadId: thread.id, text: "two" });

    const ends = store
      .listEvents(thread.id)
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: "turn-end" }> => e.kind === "turn-end");
    expect(ends).toHaveLength(2);
    expect(ends[0]!.usage).toMatchObject({ miss: false });
    expect(ends[0]!.usage?.missCause).toBeUndefined();
    expect(ends[1]!.usage).toMatchObject({ miss: false, missCause: "session-rebuild" });
  });

  it("passes the chosen effort and clears an unsupported one on a model switch", async () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const seen: (string | null | undefined)[] = [];
    const driver: AgentDriver = {
      id: "fake",
      label: "Fake",
      defaultModel: "m1",
      capabilities: SAFE_DEFAULTS,
      skillsDelivery: { mode: "none" },
      skillCallPrefix: "",
      models: () => [
        { id: "m1", label: "M1", efforts: ["low", "high"] },
        { id: "m2", label: "M2", efforts: ["low"] },
      ],
      async runTurn(input) {
        seen.push(input.effort);
      },
    };
    const service = new Service(store, () => catalog(), [driver], () => {});
    const project = store.addProject(tempDir());
    const thread = service.createThread(project.id);

    service.updateThread(thread.id, { effort: "high" });
    expect(store.getThread(thread.id).effort).toBe("high");
    await service.send({ threadId: thread.id, text: "one" });
    expect(seen).toEqual(["high"]);

    // The new model doesn't offer "high": the effort goes back to the default.
    service.updateThread(thread.id, { model: "m2" });
    expect(store.getThread(thread.id).effort).toBeNull();

    // A supported effort survives the switch.
    service.updateThread(thread.id, { effort: "low" });
    service.updateThread(thread.id, { model: "m1" });
    expect(store.getThread(thread.id).effort).toBe("low");
  });
});

describe("Service.send /compact", () => {
  it("says the agent can't compact on request, without starting a turn", async () => {
    const { store, service, driver, thread, updates } = setup(async () => {});
    store.updateThread(thread.id, { sessionId: "s1" });
    await service.send({ threadId: thread.id, text: "/compact", compact: { focus: null } });
    expect(driver.prompts).toEqual([]);
    expect(store.listEvents(thread.id).map((e) => e.event)).toEqual([{ kind: "notice", text: "Fake can't compact on request." }]);
    expect(updates).toContainEqual({ type: "running", threadId: thread.id, running: false });
  });

  it("says there's nothing to compact before the thread has a session", async () => {
    const { store, service, driver, thread } = setup(async () => {});
    driver.capabilities = { ...SAFE_DEFAULTS, manualCompact: true };
    await service.send({ threadId: thread.id, text: "/compact", compact: { focus: null } });
    expect(driver.prompts).toEqual([]);
    expect((store.listEvents(thread.id)[0]!.event as { text: string }).text).toContain("Nothing to compact yet");
  });

  it("hands the driver the compact flag and a bare /compact prompt, and counts the compaction as the reply", async () => {
    const seen: TurnInput[] = [];
    const listener = vi.fn();
    const { store, service, driver, thread } = setup(async (input) => {
      seen.push(input);
      input.onEvent({ kind: "compaction", trigger: "manual", preTokens: 48000, postTokens: 6000 });
      input.onEvent({ kind: "turn-end", costUsd: null, inputTokens: 0, outputTokens: 0, durationMs: 1 });
    });
    driver.capabilities = { ...SAFE_DEFAULTS, manualCompact: true };
    service.setTurnListener(listener);
    store.updateThread(thread.id, { sessionId: "s1", title: "Earlier work" });
    await service.send({ threadId: thread.id, text: "/compact keep the API decisions", compact: { focus: "keep the API decisions" } });
    expect(seen[0]!.compact).toEqual({ focus: "keep the API decisions" });
    expect(driver.prompts).toEqual(["/compact keep the API decisions"]);
    const kinds = store.listEvents(thread.id).map((e) => e.event.kind);
    expect(kinds).toEqual(["user", "compaction", "turn-end"]);
    expect(store.getThread(thread.id).title).toBe("Earlier work");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("the project check gate", () => {
  const node = process.execPath;
  const nodeCmd = (script: string) => `"${node}" -e "${script}"`;
  // An Edit tool-use plus a non-error result: what counts as a changed file.
  const edit = (input: TurnInput) => {
    input.onEvent({ kind: "tool-use", toolUseId: "e1", name: "Edit", summary: "a.ts" });
    input.onEvent({ kind: "tool-result", toolUseId: "e1", isError: false, summary: "Updated" });
  };

  it("runs no check when the project has no command", async () => {
    const { store, service, thread } = setup(async (input) => edit(input));
    await service.send({ threadId: thread.id, text: "go" });
    expect(store.listEvents(thread.id).filter((e) => e.event.kind === "check")).toHaveLength(0);
  });

  it("runs no check when the turn changed nothing", async () => {
    const { store, service, thread } = setup(async () => {});
    store.setCheckCommand(thread.projectId, nodeCmd("process.exit(0)"));
    await service.send({ threadId: thread.id, text: "go" });
    expect(store.listEvents(thread.id).filter((e) => e.event.kind === "check")).toHaveLength(0);
  });

  it("runs a passing check once and stops", async () => {
    const { store, service, driver, thread } = setup(async (input) => edit(input));
    store.setCheckCommand(thread.projectId, nodeCmd("process.exit(0)"));
    await service.send({ threadId: thread.id, text: "go" });
    const checks = store
      .listEvents(thread.id)
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: "check" }> => e.kind === "check");
    expect(checks).toHaveLength(2); // the running row, then the final row
    expect(checks[1]).toMatchObject({ ok: true, round: 0 });
    expect(driver.prompts).toHaveLength(1);
  });

  it("sends up to 2 fix rounds when the check keeps failing", async () => {
    const { store, service, driver, thread } = setup(async (input) => edit(input));
    store.setCheckCommand(thread.projectId, nodeCmd("process.exit(3)"), 2);
    await service.send({ threadId: thread.id, text: "go" });
    await vi.waitFor(() => expect(service.isRunning(thread.id)).toBe(false), { timeout: 10_000 });
    expect(driver.prompts).toHaveLength(3);
    expect(driver.prompts[1]).toContain("failed (exit 3)");
    expect(driver.prompts[2]).toContain("failed (exit 3)");
    // A fix round never renames the thread, and never repeats the command.
    expect(store.getThread(thread.id).title).toBe("go");
    expect(driver.prompts[1]).not.toContain("process.exit");
    const notices = store
      .listEvents(thread.id)
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: "notice" }> => e.kind === "notice")
      .map((e) => e.text);
    expect(notices).toContain("The check still fails after 2 fix attempts, so it stopped. Run it yourself or ask again.");
  });

  it("re-checks a fix round even when it made no edit the app can see", async () => {
    // Only the user's turn reports an Edit; the fix turns change nothing visible (a shell write, say).
    const { store, service, driver, thread } = setup(async (input) => {
      if (!input.prompt.includes("failed (exit 3)")) edit(input);
    });
    store.setCheckCommand(thread.projectId, nodeCmd("process.exit(3)"), 2);
    await service.send({ threadId: thread.id, text: "go" });
    await vi.waitFor(() => expect(service.isRunning(thread.id)).toBe(false), { timeout: 10_000 });
    expect(driver.prompts).toHaveLength(3);
    const checks = store.listEvents(thread.id).filter((e) => e.event.kind === "check" && e.event.ok === false);
    expect(checks).toHaveLength(3);
  });

  it("sends one fix round by default, and none when auto-fix is off", async () => {
    const one = setup(async (input) => edit(input));
    one.store.setCheckCommand(one.thread.projectId, nodeCmd("process.exit(3)"));
    await one.service.send({ threadId: one.thread.id, text: "go" });
    await vi.waitFor(() => expect(one.service.isRunning(one.thread.id)).toBe(false), { timeout: 10_000 });
    expect(one.driver.prompts).toHaveLength(2);

    const off = setup(async (input) => edit(input));
    off.store.setCheckCommand(off.thread.projectId, nodeCmd("process.exit(3)"), 0);
    await off.service.send({ threadId: off.thread.id, text: "go" });
    await vi.waitFor(() => expect(off.service.isRunning(off.thread.id)).toBe(false), { timeout: 10_000 });
    // Off: the failure shows as a row, and no token is spent on a fix turn.
    expect(off.driver.prompts).toHaveLength(1);
    const events = off.store.listEvents(off.thread.id).map((e) => e.event);
    expect(events.some((e) => e.kind === "check" && e.ok === false)).toBe(true);
    expect(events.some((e) => e.kind === "notice" && e.text.includes("fix attempt"))).toBe(false);
  });

  it("stops on interrupt during the check, with no follow-up", async () => {
    const { store, service, driver, thread, updates } = setup(async (input) => edit(input));
    store.setCheckCommand(thread.projectId, nodeCmd("setInterval(()=>{},1000)"));
    const sending = service.send({ threadId: thread.id, text: "go" });
    await vi.waitFor(() => expect(updates.some((u) => u.type === "event" && u.stored.event.kind === "check")).toBe(true), { timeout: 5000 });
    service.interrupt(thread.id);
    await sending;
    await vi.waitFor(() => expect(service.isRunning(thread.id)).toBe(false), { timeout: 5000 });
    expect(driver.prompts).toHaveLength(1);
  });
});

describe("the evidence gate", () => {
  /** A git repo holding a committed source file and test file, as the project. */
  const setupRepo = (script: (input: TurnInput) => Promise<void>, extra?: (dir: string) => void) => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const dir = tempDir();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "math.ts"), "export const add = (a: number, b: number) => a - b;\n");
    writeFileSync(join(dir, "src", "math.test.ts"), "it('adds', () => expect(add(1, 2)).toBe(3));\n");
    git("add", ".");
    git("commit", "-qm", "init");
    extra?.(dir);
    const driver = fakeDriver(script);
    const service = new Service(store, () => catalog(), [driver], () => {});
    const thread = service.createThread(store.addProject(dir).id);
    return { store, service, thread, dir };
  };
  const notices = (store: Store, threadId: string) =>
    store
      .listEvents(threadId)
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: "notice" }> => e.kind === "notice")
      .map((e) => e.text);
  const evidenceOf = (store: Store, threadId: string) =>
    store
      .listEvents(threadId)
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: "notice" }> => e.kind === "notice")
      .map((e) => e.evidence);
  const say = (input: TurnInput, text: string) => input.onEvent({ kind: "assistant-text", text });

  it("stays silent for an honest turn", async () => {
    const { store, service, thread } = setupRepo(async (input) => {
      writeFileSync(join(input.cwd, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
      input.onEvent({ kind: "tool-use", toolUseId: "r1", name: "Run", summary: "npm test", payload: { command: "npm test" } });
      say(input, "Fixed add(). All tests pass.");
    });
    await service.send({ threadId: thread.id, text: "fix add" });
    expect(notices(store, thread.id)).toEqual([]);
  });

  it("flags a skip added to an existing test and a pass claim with no test run", async () => {
    const { store, service, thread } = setupRepo(async (input) => {
      writeFileSync(join(input.cwd, "src", "math.test.ts"), "it.skip('adds', () => expect(add(1, 2)).toBe(3));\n");
      say(input, "Done. All tests pass.");
    });
    await service.send({ threadId: thread.id, text: "make the build green" });
    expect(notices(store, thread.id)).toEqual(["Worth a second look: Added .skip/.only in src/math.test.ts. Says tests or checks pass, but none ran this turn."]);
    expect(evidenceOf(store, thread.id)).toEqual([["Added .skip/.only in src/math.test.ts.", "Says tests or checks pass, but none ran this turn."]]);
  });

  it("flags a deleted test file, and reads an Edit's own diff", async () => {
    const { store, service, thread } = setupRepo(async (input) => {
      rmSync(join(input.cwd, "src", "math.test.ts"));
      writeFileSync(join(input.cwd, "src", "other.test.ts"), "it('x', () => {});\n");
      input.onEvent({ kind: "tool-use", toolUseId: "e1", name: "Edit", summary: "other.test.ts" });
      const unified = "--- /dev/null\n+++ b/src/other.test.ts\n@@ -0,0 +1 @@\n+expect(true).toBe(true);";
      input.onEvent({ kind: "tool-result", toolUseId: "e1", isError: false, summary: "+1", payload: { diff: [{ path: join(input.cwd, "src", "other.test.ts"), unified }] } });
    });
    await service.send({ threadId: thread.id, text: "clean up" });
    expect(notices(store, thread.id)).toEqual(["Worth a second look: Deleted test files: src/math.test.ts. Added trivial assert in src/other.test.ts."]);
  });

  it("expects test edits when the user asked about tests, and doesn't re-flag an earlier skip", async () => {
    const { store, service, thread } = setupRepo(
      async (input) => {
        writeFileSync(join(input.cwd, "src", "math.test.ts"), "it.skip('adds', () => expect(add(1, 2)).toBe(3));\nit('adds 0', () => expect(add(0, 0)).toBe(0));\n");
      },
      // The user's own uncommitted skip, there before the turn.
      (dir) => writeFileSync(join(dir, "src", "math.test.ts"), "it.skip('adds', () => expect(add(1, 2)).toBe(3));\n"),
    );
    await service.send({ threadId: thread.id, text: "add a test for zero" });
    expect(notices(store, thread.id)).toEqual([]);
  });

  it("flags edits to existing tests the request didn't ask for", async () => {
    const { store, service, thread } = setupRepo(async (input) => {
      writeFileSync(join(input.cwd, "src", "math.test.ts"), "it('adds', () => expect(add(1, 2)).toBe(-1));\n");
    });
    await service.send({ threadId: thread.id, text: "fix add" });
    expect(notices(store, thread.id)).toEqual(["Worth a second look: Changed existing tests: src/math.test.ts. Check they weren't loosened to pass."]);
  });

  it("counts the project's passing check as the evidence", async () => {
    const { store, service, thread } = setupRepo(async (input) => {
      writeFileSync(join(input.cwd, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
      say(input, "Fixed. Tests pass.");
    });
    store.setCheckCommand(thread.projectId, `"${process.execPath}" -e "process.exit(0)"`);
    await service.send({ threadId: thread.id, text: "fix add" });
    expect(notices(store, thread.id)).toEqual([]);
  });

  it("works outside git from the claim alone", async () => {
    const { store, service, thread } = setup(async (input) => say(input, "All tests pass."));
    await service.send({ threadId: thread.id, text: "go" });
    expect(notices(store, thread.id)).toEqual(["Worth a second look: Says tests or checks pass, but none ran this turn."]);
  });
});

describe("titleFrom", () => {
  it("uses the first line, prefixed with the skill", () => {
    expect(titleFrom("Fix the bug\nmore", undefined)).toBe("Fix the bug");
    expect(titleFrom("ticket 3", "implement")).toBe("/implement ticket 3");
    expect(titleFrom("", "skilled-setup")).toBe("/skilled-setup");
    expect(titleFrom("x".repeat(80)).length).toBe(60);
  });

  it("prefixes every skill in order", () => {
    expect(titleFrom("fix login", ["tdd", "review"])).toBe("/tdd /review fix login");
    expect(titleFrom("", ["tdd", "review"])).toBe("/tdd /review");
  });
});

describe("worktree threads", () => {
  const repo = () => {
    const dir = tempDir();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
    return dir;
  };

  const setupWorktrees = (worktreesDir: string, driver: AgentDriver) => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const service = new Service(store, () => catalog(), [driver], () => {}, undefined, undefined, undefined, undefined, worktreesDir);
    return { store, service };
  };

  it("gives a thread its own worktree and runs its turns there", async () => {
    const cwds: string[] = [];
    const driver = fakeDriver(async (input) => {
      cwds.push(input.cwd);
    });
    const { store, service } = setupWorktrees(tempDir(), driver);
    const project = store.addProject(repo());

    const thread = await service.createWorktreeThread(project.id);
    expect(thread.branch).toMatch(/^harness\//);
    expect(thread.worktreePath).toBeTruthy();
    expect(existsSync(thread.worktreePath!)).toBe(true);
    expect(store.getThread(thread.id)).toMatchObject({ branch: thread.branch, worktreePath: thread.worktreePath });

    await service.send({ threadId: thread.id, text: "hi" });
    expect(cwds).toEqual([thread.worktreePath]);
  });

  it("leaves no thread behind when the worktree can't be made", async () => {
    const { store, service } = setupWorktrees(tempDir(), fakeDriver(async () => {}));
    const project = store.addProject(tempDir()); // not a git repository

    await expect(service.createWorktreeThread(project.id)).rejects.toThrow(/git repository/);
    expect(store.listThreads(project.id)).toEqual([]);
  });

  it("removes a clean worktree when its thread is deleted", async () => {
    const { store, service } = setupWorktrees(tempDir(), fakeDriver(async () => {}));
    const project = store.addProject(repo());

    const thread = await service.createWorktreeThread(project.id);
    expect(existsSync(thread.worktreePath!)).toBe(true);
    await service.deleteThread(thread.id);
    expect(existsSync(thread.worktreePath!)).toBe(false);
    expect(store.listThreads(project.id)).toEqual([]);
  });

  it("deletes a project, stopping threads and cleaning up worktrees", async () => {
    const { store, service } = setupWorktrees(tempDir(), fakeDriver(async () => {}));
    const project = store.addProject(repo());

    const thread = await service.createWorktreeThread(project.id);
    expect(existsSync(thread.worktreePath!)).toBe(true);
    await service.deleteProject(project.id);
    expect(existsSync(thread.worktreePath!)).toBe(false);
    expect(store.listProjects().find((p) => p.id === project.id)).toBeUndefined();
    expect(store.listThreads(project.id)).toEqual([]);
  });
});

describe("Service questions", () => {
  const questions = [
    { id: "q0", header: "Format", question: "Which format?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }], multiSelect: false, allowOther: true },
    { id: "q1", header: "Key", question: "Your API key?", options: [], multiSelect: false, allowOther: true, secret: true },
  ];

  it("routes an agent's questions to the UI and back, keeping secrets out of history", async () => {
    let answer: unknown = null;
    const { service, thread, store, updates } = setup(async (input) => {
      answer = await input.requestUserInput!(questions);
    });
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    const req = updates.find((u) => u.type === "question") as Extract<LiveUpdate, { type: "question" }>;
    expect(req.request.questions).toHaveLength(2);
    service.respondQuestion(req.request.requestId, { answers: { q0: ["B"], q1: ["sk-secret-123"] }, notes: { q0: "B but smaller", q1: "never store" } });
    await sending;
    expect(answer).toEqual({ answers: { q0: ["B"], q1: ["sk-secret-123"] }, notes: { q0: "B but smaller", q1: "never store" } });
    const recorded = store.listEvents(thread.id).find((e) => e.event.kind === "questions")!.event;
    expect(recorded).toEqual({
      kind: "questions",
      skipped: false,
      items: [
        { header: "Format", question: "Which format?", answer: ["B"], note: "B but smaller" },
        { header: "Key", question: "Your API key?", answer: ["•••"] },
      ],
    });
    expect(updates.some((u) => u.type === "question-done")).toBe(true);
  });

  it("resolves pending questions as dismissed when interrupted", async () => {
    let answer: unknown = null;
    const { service, thread, updates } = setup(async (input) => {
      answer = await input.requestUserInput!(questions);
    });
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    service.interrupt(thread.id);
    await sending;
    expect(answer).toBe("dismiss");
    expect(updates.some((u) => u.type === "question-done")).toBe(true);
  });

  it("lets a harness tool ask for a running thread only", async () => {
    let release!: () => void;
    const { service, thread, updates } = setup(() => new Promise<void>((r) => (release = r)));
    expect(service.askFromTool(thread.id, questions)).toBeNull();
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    const tool = new AbortController();
    const asked = service.askFromTool(thread.id, questions, tool.signal)!;
    expect(updates.some((u) => u.type === "question")).toBe(true);
    // The agent gave up on the call: the card goes away and the tool gets a skip.
    tool.abort();
    expect(await asked).toBe("dismiss");
    release();
    await sending;
  });
});

describe("Service async questions", () => {
  const questions = [{ id: "q0", header: "", question: "Free-form or fixed?", options: [{ label: "Free-form", description: "" }], multiSelect: false, allowOther: true }];

  it("steers the running turn with the answer when the agent can take it", async () => {
    let release!: () => void;
    const steered: string[] = [];
    const { service, thread, updates, driver } = setup(async (input) => {
      void input.requestUserInput!(questions, { async: true });
      await new Promise<void>((r) => (release = r));
    });
    driver.steer = async (_t, text) => {
      steered.push(text);
      return true;
    };
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    const req = updates.find((u) => u.type === "question") as Extract<LiveUpdate, { type: "question" }>;
    expect(req.request.async).toBe(true);
    expect(service.pendingState().questions.map((q) => q.requestId)).toEqual([req.request.requestId]);
    expect(service.pendingState().running).toEqual([thread.id]);
    service.respondQuestion(req.request.requestId, { answers: { q0: ["Free-form"] } });
    await new Promise((r) => setTimeout(r, 10));
    expect(steered[0]).toContain("Answer: Free-form");
    release();
    await sending;
    expect(driver.prompts).toHaveLength(1);
  });

  it("keeps the card after the turn and sends the answer as the next message", async () => {
    const { service, thread, updates, driver } = setup(async (input) => {
      void input.requestUserInput!(questions, { async: true });
    });
    await service.send({ threadId: thread.id, text: "go" });
    const req = updates.find((u) => u.type === "question") as Extract<LiveUpdate, { type: "question" }>;
    expect(service.pendingState().questions).toHaveLength(1);
    service.respondQuestion(req.request.requestId, { answers: { q0: ["Free-form"] } });
    await new Promise((r) => setTimeout(r, 30));
    expect(driver.prompts).toHaveLength(2);
    expect(driver.prompts[1]).toContain("Answer: Free-form");
  });

  it("a skipped async question after the turn sends nothing", async () => {
    const { service, thread, updates, driver } = setup(async (input) => {
      void input.requestUserInput!(questions, { async: true });
    });
    await service.send({ threadId: thread.id, text: "go" });
    const req = updates.find((u) => u.type === "question") as Extract<LiveUpdate, { type: "question" }>;
    service.respondQuestion(req.request.requestId, "dismiss");
    await new Promise((r) => setTimeout(r, 30));
    expect(driver.prompts).toHaveLength(1);
  });

  it("lists open permissions for a reloaded window", async () => {
    let release!: () => void;
    const { service, thread } = setup(async (input) => {
      void input.requestPermission({ toolName: "Bash", summary: "ls", canAlwaysAllow: false });
      await new Promise<void>((r) => (release = r));
    });
    const sending = service.send({ threadId: thread.id, text: "go" });
    await new Promise((r) => setTimeout(r, 10));
    expect(service.pendingState().permissions).toMatchObject([{ threadId: thread.id, toolName: "Bash", summary: "ls" }]);
    service.interrupt(thread.id);
    release();
    await sending;
    expect(service.pendingState()).toEqual({ running: [], permissions: [], plans: [], questions: [] });
  });
});

describe("Chats (no project)", () => {
  const setupChats = (driver: AgentDriver) => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const root = join(tempDir(), "chats");
    mkdirSync(root, { recursive: true });
    const service = new Service(store, () => catalog(), [driver], () => {}, undefined, undefined, undefined, undefined, null, null, root);
    return { store, service, project: store.addProject(root) };
  };

  it("gives each chat its own folder, with no branch, and runs its turns there", async () => {
    const cwds: string[] = [];
    const { store, service, project } = setupChats(fakeDriver(async (input) => void cwds.push(input.cwd)));

    const a = service.createThread(project.id);
    const b = service.createThread(project.id);
    expect(a.worktreePath).toBe(join(project.path, a.id));
    expect(b.worktreePath).toBe(join(project.path, b.id));
    expect(a.branch).toBeNull();
    expect(existsSync(a.worktreePath!)).toBe(true);
    expect(store.getThread(a.id).worktreePath).toBe(a.worktreePath);

    await service.send({ threadId: a.id, text: "hi" });
    expect(cwds).toEqual([a.worktreePath]);
  });

  it("makes a chat's folder again when it's gone", async () => {
    const cwds: string[] = [];
    const { service, project } = setupChats(fakeDriver(async (input) => void cwds.push(input.cwd)));
    const chat = service.createThread(project.id);
    rmSync(chat.worktreePath!, { recursive: true });

    await service.send({ threadId: chat.id, text: "hi" });
    expect(cwds).toEqual([chat.worktreePath]);
  });

  it("asks for no git: a worktree thread in Chats is a plain chat", async () => {
    const { service, project } = setupChats(fakeDriver(async () => {}));
    const chat = await service.createWorktreeThread(project.id);
    expect(chat.branch).toBeNull();
    expect(chat.worktreePath).toBe(join(project.path, chat.id));
  });

  it("deletes a chat's folder with the chat, and nothing outside it", async () => {
    const { store, service, project } = setupChats(fakeDriver(async () => {}));
    const chat = service.createThread(project.id);
    const other = service.createThread(project.id);
    writeFileSync(join(chat.worktreePath!, "notes.md"), "x");

    await service.deleteThread(chat.id);
    expect(existsSync(chat.worktreePath!)).toBe(false);
    expect(existsSync(other.worktreePath!)).toBe(true);
    expect(existsSync(project.path)).toBe(true);
    expect(store.listThreads(project.id).map((t) => t.id)).toEqual([other.id]);
  });

  it("refuses to remove Chats", async () => {
    const { store, service, project } = setupChats(fakeDriver(async () => {}));
    service.createThread(project.id);
    await expect(service.deleteProject(project.id)).rejects.toThrow(/Chats can't be removed/);
    expect(store.listThreads(project.id)).toHaveLength(1);
  });

  it("leaves other projects' threads in the project folder", () => {
    const { store, service } = setupChats(fakeDriver(async () => {}));
    const other = store.addProject(tempDir());
    expect(service.createThread(other.id).worktreePath ?? null).toBeNull();
  });
});
