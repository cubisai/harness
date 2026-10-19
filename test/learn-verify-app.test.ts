import { describe, expect, it } from "vitest";
import type { AgentDriver } from "../src/main/agents/types";
import type { LearnDb } from "../src/main/learn/db";
import { createVerifier, keepAlive } from "../src/main/learn/verify-app";
import { LEARN_DEFAULTS, type Lesson } from "../src/shared/learn";

const lesson = { id: "l1", projectId: "p1", caseId: "abcdef0123456789" } as unknown as Lesson;

describe("keepAlive", () => {
  it("hides dispose and keeps every other member bound to the driver", () => {
    let disposed = false;
    const d = { id: "x", n: 2, dispose: () => (disposed = true), twice(this: { n: number }) { return this.n * 2; } } as unknown as AgentDriver & { twice(): number };
    const k = keepAlive(d) as typeof d;
    expect(k.dispose).toBeUndefined();
    k.dispose?.();
    expect(disposed).toBe(false);
    expect(k.id).toBe("x");
    expect(k.twice()).toBe(4);
  });
});

describe("createVerifier", () => {
  const base = { casesRoot: () => "/none", projectPath: () => "/none", appVersion: "1.0.0" };

  it("refuses without a background model", async () => {
    const verify = createVerifier({ ...base, db: { spent: () => 0 } as unknown as LearnDb, settings: () => LEARN_DEFAULTS, drivers: () => [] });
    expect(await verify(lesson)).toMatchObject({ verification: null, promote: false, why: "no background model can run a replay", tokens: 0 });
  });

  it("refuses once today's background budget is spent", async () => {
    const driver = { id: "provider-cheap", defaultModel: "flash", label: "Cheap", models: () => [{ id: "flash", label: "Flash" }] } as unknown as AgentDriver;
    const settings = { ...LEARN_DEFAULTS, background: { agent: "provider-cheap", model: "flash" } };
    const verify = createVerifier({ ...base, db: { spent: () => settings.dailyTokens } as unknown as LearnDb, settings: () => settings, drivers: () => [driver] });
    expect(await verify(lesson)).toMatchObject({ promote: false, why: "today's background budget is spent; try again tomorrow" });
  });
});
