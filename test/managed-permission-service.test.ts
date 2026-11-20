import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import type { LiveUpdate } from "../src/shared/types";
import { catalog, closeAfter, tempDir } from "./helpers";

describe("ordinary managed approvals versus mandatory single-use Ask", () => {
  it("remembers normal exact identities but a forced Ask cannot consume or rewrite them", async () => {
    const store = new Store(join(tempDir(), "fixture.db")); closeAfter(() => store.close());
    const updates: LiveUpdate[] = []; let input!: TurnInput, release!: () => void;
    const driver: AgentDriver = { id: "fixture", label: "Fixture", defaultModel: "fake", capabilities: SAFE_DEFAULTS, skillCallPrefix: "$", skillsDelivery: { mode: "none" }, models: () => [{ id: "fake", label: "Fixture" }], runTurn: async (i) => { input = i; await new Promise<void>((r) => { release = r; }); } };
    const service = new Service(store, () => catalog(), [driver], (u) => updates.push(u)); closeAfter(() => service.dispose());
    const project = store.addProject(tempDir()), thread = service.createThread(project.id);
    const turn = service.send({ threadId: thread.id, text: "Local fake turn" }); await vi.waitFor(() => expect(input).toBeDefined());
    const identity = { name: "call_mcp_tool", summary: '{"identity":"one","args":{"day":1}}' };
    const first = service.permissionFromTool(thread.id, "Connector · fixture.summary", "day: 1", input.signal, identity);
    const requests = () => updates.filter((u) => u.type === "permission");
    expect(requests()).toHaveLength(1); expect(requests()[0]!.request.canAlwaysAllow).toBe(true);
    service.respondPermission(requests()[0]!.request.requestId, "allow-always"); expect(await first).toBe(true);
    expect(await service.permissionFromTool(thread.id, "Connector · fixture.summary", "day: 1", input.signal, identity)).toBe(true); expect(requests()).toHaveLength(1);
    const forced = service.permissionFromTool(thread.id, "Connector · fixture.summary", "day: 1", input.signal);
    expect(requests()).toHaveLength(2); expect(requests()[1]!.request.canAlwaysAllow).toBe(false);
    service.respondPermission(requests()[1]!.request.requestId, "deny"); expect(await forced).toBe(false);
    expect(await service.permissionFromTool(thread.id, "Connector · fixture.summary", "day: 1", input.signal, identity)).toBe(true); expect(requests()).toHaveLength(2);
    const changed = service.permissionFromTool(thread.id, "Connector · fixture.summary", "day: 1", input.signal, { ...identity, summary: "different spec/schema identity" });
    expect(requests()).toHaveLength(3); service.respondPermission(requests()[2]!.request.requestId, "deny"); expect(await changed).toBe(false);
    release(); await turn;
  });
});
