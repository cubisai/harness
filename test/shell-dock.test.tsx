import { describe, expect, it } from "vitest";
import { shellState, uptime } from "../src/renderer/src/components/ShellDock";

describe("ShellDock labels", () => {
  it("formats uptime by seconds, minutes and hours, frozen once the shell ended", () => {
    expect(uptime({ startedAt: 0, endedAt: null }, 42_000)).toBe("42s");
    expect(uptime({ startedAt: 0, endedAt: null }, 185_000)).toBe("3m 05s");
    expect(uptime({ startedAt: 0, endedAt: null }, 3_720_000)).toBe("1h 02m");
    expect(uptime({ startedAt: 0, endedAt: 5_000 }, 99_000)).toBe("5s");
  });

  it("names the state", () => {
    expect(shellState({ status: "running", exitCode: null })).toBe("running");
    expect(shellState({ status: "stopped", exitCode: null })).toBe("stopped");
    expect(shellState({ status: "exited", exitCode: 1 })).toBe("exited 1");
  });
});
