import { describe, expect, it } from "vitest";
import { StdioRpc } from "../src/main/agents/rpc";

describe("StdioRpc", () => {
  it("survives writes to an agent that stopped reading (EPIPE)", async () => {
    // The child closes its stdin at once but stays alive, so every write after that fails with EPIPE.
    const rpc = StdioRpc.spawn(process.execPath, ["-e", "process.stdin.destroy(); setTimeout(() => {}, 400)"], { cwd: process.cwd(), env: process.env }, {
      onRequest: async () => null,
      onNotification: () => {},
    });
    await new Promise((r) => setTimeout(r, 150));
    for (let i = 0; i < 20; i++) rpc.notify("ping", { i, pad: "x".repeat(10_000) });
    await new Promise((r) => setTimeout(r, 100));
    rpc.close();
    await rpc.closed();
    expect(rpc.alive).toBe(false);
  });
});
