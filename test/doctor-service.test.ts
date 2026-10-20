import { describe, expect, it } from "vitest";
import { applyPin } from "../src/main/agents/binaries";
import { pinsByCommand } from "../src/main/doctor";

describe("pinned installs", () => {
  const resolution = { path: "/a/new", version: "2.0.0", others: [{ path: "/b/old", version: "1.0.0" }] };
  it("moves the pinned install first while it's still installed", () => {
    expect(applyPin(resolution, "/b/old")).toEqual({ path: "/b/old", version: "1.0.0", others: [{ path: "/a/new", version: "2.0.0" }] });
  });
  it("ignores a pin that's no longer installed, or none", () => {
    expect(applyPin(resolution, "/gone")).toBe(resolution);
    expect(applyPin(resolution, undefined)).toBe(resolution);
    expect(applyPin(null, "/b/old")).toBeNull();
  });
  it("keys pins by command for the resolver", () => {
    const agents = () => [
      { id: "claude", label: "Claude Code", command: "claude", installHint: null },
      { id: "opencode", label: "OpenCode", command: "opencode", installHint: null },
    ];
    expect(pinsByCommand({ agents, pinned: () => ({ opencode: "/usr/local/bin/opencode", gone: "/x" }) })).toEqual({ opencode: "/usr/local/bin/opencode" });
  });
});
