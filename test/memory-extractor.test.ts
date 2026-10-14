import { describe, expect, it, vi } from "vitest";
import type { AgentCapabilities, ModelOption } from "../src/shared/types";
import type { AgentDriver } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { applyOps, buildExtractionPrompt, createExtractor, parseOps, pickExtractorModel } from "../src/main/memory/extractor";
import { GLOBAL_SCOPE, MemoryStore } from "../src/main/memory/store";
import { tempDir } from "./helpers";

function extractorDriver(over: { oneShot: AgentDriver["oneShot"]; capabilities?: Partial<AgentCapabilities>; models?: ModelOption[] }): AgentDriver {
  return {
    id: "codex",
    label: "Codex",
    defaultModel: "m",
    capabilities: { ...SAFE_DEFAULTS, ...over.capabilities },
    skillsDelivery: { mode: "none" },
    skillCallPrefix: "",
    models: () => over.models ?? [],
    async runTurn() {},
    oneShot: over.oneShot,
  };
}

const ADD_JSON = '{"ops":[{"op":"add","name":"tabs","description":"prefers tabs","type":"feedback","body":"Use tabs."}]}';

describe("pickExtractorModel", () => {
  it("picks the cheapest hint by name, in priority order, and its lowest effort", () => {
    const models: ModelOption[] = [
      { id: "big", label: "Big" },
      { id: "b", label: "Mini", efforts: ["low", "high"] },
      { id: "c", label: "Flash", efforts: ["none", "low"] },
    ];
    expect(pickExtractorModel(models, "big")).toEqual({ model: "b", effort: "low" });
  });

  it("prefers an earlier hint even when a cheaper-sounding one appears later", () => {
    const models: ModelOption[] = [
      { id: "big", label: "Big" },
      { id: "x", label: "Flash" },
      { id: "y", label: "Nano" },
    ];
    expect(pickExtractorModel(models, "big").model).toBe("y");
  });

  it("falls back to the current model and its effort", () => {
    const models: ModelOption[] = [{ id: "big", label: "Big", efforts: ["medium", "high"] }];
    expect(pickExtractorModel(models, "big")).toEqual({ model: "big", effort: "medium" });
  });

  it("keeps a thread model that's already cheap, and only looks within its provider", () => {
    const models: ModelOption[] = [
      { id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra (free)" },
      { id: "opencode-go/gpt-mini", label: "GPT mini" },
      { id: "opencode/big", label: "Big" },
      { id: "opencode/qwen-flash", label: "Qwen Flash" },
    ];
    expect(pickExtractorModel(models, "opencode/nemotron-3-ultra-free").model).toBe("opencode/nemotron-3-ultra-free");
    // Never another provider's model (opencode-go needs a paid plan), even with an earlier hint.
    expect(pickExtractorModel(models, "opencode/big").model).toBe("opencode/qwen-flash");
  });

  it("is null when nothing cheap exists and the current model lists no low effort", () => {
    expect(pickExtractorModel([{ id: "big", label: "Big", efforts: ["high"] }], "big")).toEqual({ model: "big", effort: null });
  });
});

describe("buildExtractionPrompt", () => {
  it("carries the index and both sides of the turn, saying (empty) for none", () => {
    const prompt = buildExtractionPrompt("- [Tabs](tabs.md) — prefers tabs", { user: "use tabs", answer: "ok" });
    expect(prompt).toContain("- [Tabs](tabs.md) — prefers tabs");
    expect(prompt).toContain("User: use tabs");
    expect(prompt).toContain("Assistant: ok");
    expect(buildExtractionPrompt("", { user: "u", answer: "a" })).toContain("(empty)");
  });

  it("clips user and answer to 2000 characters", () => {
    const long = "x".repeat(2500);
    const prompt = buildExtractionPrompt("", { user: long, answer: long });
    expect(prompt).toContain(`${"x".repeat(2000)}…`);
    expect(prompt).not.toContain(`${"x".repeat(2001)}`);
  });
});

describe("parseOps", () => {
  it("accepts an add, a fenced object, and defaults an unknown type to project", () => {
    const ops = parseOps('```json\n{"ops":[{"op":"add","name":"tabs","description":"d","type":"mystery","body":"b"}]}\n```', new Set());
    expect(ops).toEqual([{ op: "add", name: "tabs", description: "d", type: "project", body: "b" }]);
  });

  it("reads the keyed form small models write ({\"add\": {...}})", () => {
    // Verbatim shape from nemotron-3-ultra-free in the live check (2026-09-29).
    const text = '{"ops":[{"add":{"name":"commit_messages_style.md","description":"commit messages must be lowercase","type":"project","body":"lowercase commits"}},{"delete":{"file":"old.md"}}]}';
    expect(parseOps(text, new Set(["old.md"]))).toEqual([
      { op: "add", name: "commit_messages_style.md", description: "commit messages must be lowercase", type: "project", body: "lowercase commits" },
      { op: "delete", file: "old.md" },
    ]);
  });

  it("returns [] for garbage", () => {
    expect(parseOps("no json here", new Set())).toEqual([]);
    expect(parseOps("{not json}", new Set())).toEqual([]);
    expect(parseOps('{"ops":"nope"}', new Set())).toEqual([]);
  });

  it("caps at five valid ops", () => {
    const raw = { ops: Array.from({ length: 7 }, (_, i) => ({ op: "add", name: `n${i}`, description: "d", type: "project", body: "b" })) };
    expect(parseOps(JSON.stringify(raw), new Set())).toHaveLength(5);
  });

  it("drops update/delete for unknown files and keeps the known ones", () => {
    const ops = parseOps(
      JSON.stringify({ ops: [
        { op: "update", file: "known.md", description: "new" },
        { op: "update", file: "missing.md", description: "x" },
        { op: "delete", file: "missing.md" },
        { op: "delete", file: "known.md" },
      ] }),
      new Set(["known.md"]),
    );
    expect(ops).toEqual([{ op: "update", file: "known.md", description: "new" }, { op: "delete", file: "known.md" }]);
  });

  it("drops an op whose text looks like a credential", () => {
    const ops = parseOps(
      JSON.stringify({ ops: [
        { op: "add", name: "key", description: "the key", type: "reference", body: "API_KEY=abcdef1234567890" },
        { op: "add", name: "safe", description: "fine", type: "project", body: "no secrets" },
      ] }),
      new Set(),
    );
    expect(ops).toEqual([{ op: "add", name: "safe", description: "fine", type: "project", body: "no secrets" }]);
  });

  it("drops an add with no name, description or body", () => {
    const raw = { ops: [{ op: "add", name: "", description: "d", body: "b" }, { op: "add", name: "x", description: "", body: "b" }, { op: "add", name: "y", description: "d", body: "" }] };
    expect(parseOps(JSON.stringify(raw), new Set())).toEqual([]);
  });
});

describe("applyOps", () => {
  it("adds, updates and deletes against a store", () => {
    const store = new MemoryStore(tempDir());
    const added = applyOps(store, "p1", [{ op: "add", name: "Tabs", description: "prefers tabs", type: "feedback", body: "Use tabs." }]);
    expect(added).toEqual({ added: 1, updated: 0, deleted: 0 });
    const file = store.list("p1")[0]!.file;

    const updated = applyOps(store, "p1", [{ op: "update", file, description: "changed" }]);
    expect(updated).toEqual({ added: 0, updated: 1, deleted: 0 });
    expect(store.read("p1", file)).toMatchObject({ name: "Tabs", description: "changed", body: "Use tabs." });

    const deleted = applyOps(store, "p1", [{ op: "delete", file }]);
    expect(deleted).toEqual({ added: 0, updated: 0, deleted: 1 });
    expect(store.list("p1")).toEqual([]);
  });

  it("never throws on a bad op", () => {
    const store = new MemoryStore(tempDir());
    expect(() => applyOps(store, "p1", [{ op: "update", file: "missing.md" }, { op: "delete", file: "missing.md" }])).not.toThrow();
  });

  it("writes a user add to the global scope and a project add to the project", () => {
    const store = new MemoryStore(tempDir());
    const result = applyOps(store, "p1", [
      { op: "add", name: "Tabs", description: "prefers tabs", type: "user", body: "Use tabs." },
      { op: "add", name: "Build", description: "builds with bun", type: "project", body: "Use bun." },
    ]);
    expect(result).toEqual({ added: 2, updated: 0, deleted: 0 });
    expect(store.list(GLOBAL_SCOPE).map((f) => f.name)).toEqual(["Tabs"]);
    expect(store.list("p1").map((f) => f.name)).toEqual(["Build"]);
  });
});

describe("createExtractor", () => {
  const base = () => ({ projectId: "p1", threadId: "t1", agentId: "codex", model: "m", user: "u".repeat(50), answer: "a".repeat(50) });

  it("debounces per thread and applies the extracted ops once", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore(tempDir());
      const oneShot = vi.fn(async (_req: Parameters<NonNullable<AgentDriver["oneShot"]>>[0]) => ADD_JSON);
      const ex = createExtractor({ store, enabled: () => true, driverFor: () => extractorDriver({ oneShot }), log: () => {} });
      ex.schedule(base());
      const second = `second user message ${"y".repeat(60)}`;
      ex.schedule({ ...base(), user: second, answer: "newer answer" });
      expect(oneShot).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(oneShot).toHaveBeenCalledTimes(1);
      expect(store.list("p1").map((f) => f.file)).toEqual(["tabs.md"]);
      const prompt = oneShot.mock.calls[0]![0].prompt;
      expect(prompt).toContain(second);
      ex.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a turn whose agent wrote its own memory", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore(tempDir());
      const oneShot = vi.fn(async () => ADD_JSON);
      const ex = createExtractor({ store, enabled: () => true, driverFor: () => extractorDriver({ oneShot }), log: () => {} });
      ex.schedule({ ...base(), wroteMemory: true });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(oneShot).not.toHaveBeenCalled();
      expect(store.list("p1")).toEqual([]);
      ex.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never calls a native-memory driver", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore(tempDir());
      const oneShot = vi.fn(async () => ADD_JSON);
      const driver = extractorDriver({ oneShot, capabilities: { nativeMemory: true } });
      const ex = createExtractor({ store, enabled: () => true, driverFor: () => driver, log: () => {} });
      ex.schedule(base());
      await vi.advanceTimersByTimeAsync(31_000);
      expect(oneShot).not.toHaveBeenCalled();
      ex.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing for a disabled project, a missing driver, or a short delta", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore(tempDir());
      const oneShot = vi.fn(async () => ADD_JSON);
      const enabled = createExtractor({ store, enabled: () => false, driverFor: () => extractorDriver({ oneShot }), log: () => {} });
      enabled.schedule(base());
      const missing = createExtractor({ store, enabled: () => true, driverFor: () => undefined, log: () => {} });
      missing.schedule(base());
      const short = createExtractor({ store, enabled: () => true, driverFor: () => extractorDriver({ oneShot }), log: () => {} });
      short.schedule({ ...base(), user: "hi", answer: "ok" });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(oneShot).not.toHaveBeenCalled();
      enabled.dispose();
      missing.dispose();
      short.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a rejecting oneShot", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore(tempDir());
      const oneShot = vi.fn(async () => {
        throw new Error("boom");
      });
      const ex = createExtractor({ store, enabled: () => true, driverFor: () => extractorDriver({ oneShot }), log: () => {} });
      ex.schedule(base());
      await vi.advanceTimersByTimeAsync(31_000);
      expect(store.list("p1")).toEqual([]);
      ex.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries once on the thread's own model when the cheap pick fails", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore(tempDir());
      const oneShot = vi.fn(async (req: Parameters<NonNullable<AgentDriver["oneShot"]>>[0]) => {
        if (req.model === "m-mini") throw new Error("model not on this plan");
        return ADD_JSON;
      });
      const driver = { ...extractorDriver({ oneShot }), models: () => [{ id: "m", label: "M" }, { id: "m-mini", label: "M mini" }] };
      const ex = createExtractor({ store, enabled: () => true, driverFor: () => driver, log: () => {} });
      ex.schedule(base());
      await vi.advanceTimersByTimeAsync(31_000);
      expect(oneShot.mock.calls.map((c) => c[0].model)).toEqual(["m-mini", "m"]);
      expect(store.list("p1").map((f) => f.file)).toEqual(["tabs.md"]);
      ex.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
