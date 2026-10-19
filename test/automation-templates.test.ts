import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { sourcesForTemplate, viewOf } from "../src/main/automations/app";
import { AutomationStore, type Automation } from "../src/main/automations/store";
import { validSchedule } from "../src/main/automations/schedule";
import { templates } from "../src/main/automations/templates";
import { closeAfter, tempDir } from "./helpers";

const IDS = ["repo-health", "browser-smoke", "project-brief", "eval-regression", "custom"];

type NewAutomation = Omit<Automation, "createdAt" | "updatedAt" | "configVersion">;

const base = (over: Partial<NewAutomation> = {}): NewAutomation => ({
  id: "a1",
  projectId: "p1",
  name: "Nightly",
  template: "repo-health",
  prompt: "check the repo",
  schedule: { kind: "interval", everyMinutes: 5 },
  missed: "coalesce",
  enabled: true,
  agent: null,
  model: null,
  budgetUsd: 0.5,
  permissions: "unattended",
  anchor: 1000,
  ...over,
});

/** A real Store on a temp file, with a fixed clock handed to the automation store. */
function open(now = () => Date.now()): { store: Store; db: AutomationStore } {
  const store = new Store(join(tempDir(), "m.db"));
  return { store, db: new AutomationStore(store.sql, now) };
}

describe("automation templates", () => {
  it("lists unique ids in order, each with a valid daily schedule", () => {
    const ts = templates("UTC");
    expect(ts.map((t) => t.id)).toEqual(IDS);
    expect(new Set(ts.map((t) => t.id)).size).toBe(ts.length);
    for (const t of ts) {
      expect(validSchedule(t.schedule)).toBeNull();
      expect(t.schedule).toMatchObject({ kind: "daily", at: "09:00", timeZone: "UTC" });
    }
  });

  it("asks every non-custom prompt not to edit files, and leaves custom empty", () => {
    for (const t of templates("UTC")) {
      if (t.id === "custom") expect(t.prompt).toBe("");
      else expect(t.prompt).toContain("Don't edit any files.");
    }
  });

  it("reads git only for the project brief", () => {
    expect(sourcesForTemplate("project-brief")).toEqual(["git"]);
    expect(sourcesForTemplate("repo-health")).toEqual([]);
  });
});

describe("viewOf", () => {
  it("renders the schedule phrase and the next run for an enabled automation", () => {
    const now = 10_000;
    const { store, db } = open(() => now);
    closeAfter(() => store.close());
    const a = db.create(base());

    const v = viewOf(a, db, now);
    expect(v.scheduleText).toBe("every 5 min");
    expect(v.nextAt).not.toBeNull();
    expect(v.nextAt!).toBeGreaterThan(now);
    expect(v.lastRun).toBeNull();
  });

  it("has no next run while disabled", () => {
    const now = 10_000;
    const { store, db } = open(() => now);
    closeAfter(() => store.close());
    const a = db.create(base({ enabled: false }));
    expect(viewOf(a, db, now).nextAt).toBeNull();
  });

  it("takes lastRun from the newest run", () => {
    const now = 10_000;
    const { store, db } = open(() => now);
    closeAfter(() => store.close());
    const a = db.create(base());
    db.claimRun("a1", "k1", 100);
    const newer = db.claimRun("a1", "k2", 300)!;
    db.finishRun(newer.id, { status: "succeeded", costUsd: 0.2 });

    const v = viewOf(db.get("a1")!, db, now);
    expect(v.lastRun).toMatchObject({ automationId: "a1", runId: newer.id, status: "succeeded", costUsd: 0.2 });
  });
});
