import { describe, expect, it } from "vitest";
import { smokeCanonicalEvents, smokeHandoff, smokeMigration, smokeProviders } from "../src/main/smoke-checks";
import { tempDir } from "./helpers";

// The same checks `electron . --smoke` prints as "smoke: <name> ok".
describe("smoke checks", () => {
  it("providers", () => {
    expect(smokeProviders(tempDir())).toEqual({ ok: true });
  });

  it("migration", () => {
    expect(smokeMigration(tempDir())).toEqual({ ok: true });
  });

  it("handoff", async () => {
    expect(await smokeHandoff(tempDir())).toEqual({ ok: true });
  });

  it("canonical events from Claude's adapter", () => {
    const r = smokeCanonicalEvents();
    expect(r.detail).toBeUndefined();
    expect(r.ok).toBe(true);
  });
});
