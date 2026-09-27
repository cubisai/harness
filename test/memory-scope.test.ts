import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { memoryScopeCheck } from "../src/main/inject/memory-scope";
import { Service } from "../src/main/service";
import { composePrompt } from "../src/main/skills/compose";
import { catalog, closeAfter, tempDir } from "./helpers";

function project(files: string[]): string {
  const dir = tempDir();
  for (const f of files) writeFileSync(join(dir, f), "# conventions\n");
  return dir;
}

describe("memoryScopeCheck", () => {
  it("warns when a project has both CLAUDE.md and AGENTS.md", () => {
    const warnings = memoryScopeCheck(project(["CLAUDE.md", "AGENTS.md"]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/CLAUDE\.md/);
    expect(warnings[0]).toMatch(/AGENTS\.md/);
  });

  it("says nothing for AGENTS.md alone", () => {
    expect(memoryScopeCheck(project(["AGENTS.md"]))).toEqual([]);
  });

  it("emits exactly one notice across turns in the same project", async () => {
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const driver: AgentDriver = {
      id: "fake",
      label: "Fake",
      defaultModel: "m",
      capabilities: SAFE_DEFAULTS,
      skillsDelivery: { mode: "none" },
      skillCallPrefix: "",
      models: () => [{ id: "m", label: "M" }],
      runTurn: async (input: TurnInput) => input.onEvent({ kind: "assistant-text", text: "ok" }),
    };
    const service = new Service(store, () => catalog(), [driver], () => {});
    const p = store.addProject(project(["CLAUDE.md", "AGENTS.md"]));
    const thread = service.createThread(p.id);
    await service.send({ threadId: thread.id, text: "one" });
    await service.send({ threadId: thread.id, text: "two" });
    const notices = store.listEvents(thread.id).filter((e) => e.event.kind === "notice" && /AGENTS\.md/.test((e.event as { text: string }).text));
    expect(notices).toHaveLength(1);
  });
});

describe("composing a skill the agent would also load itself", () => {
  it("still composes it when the user runs it explicitly", () => {
    const cat = catalog();
    const modelSkill = cat.modelSkills[0];
    expect(modelSkill).toBeDefined();
    expect(composePrompt(cat, "x", modelSkill!.name)).toContain(`<skill name="${modelSkill!.name}"`);
  });
});
