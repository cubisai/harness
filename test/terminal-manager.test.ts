import { describe, expect, it, vi } from "vitest";
import { TerminalManager } from "../src/main/terminal";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node-pty", () => ({ spawn }));

function pty() {
  const term = {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    data: (_data: string) => {}, exit: (_event: { exitCode: number }) => {},
    onData(callback: (data: string) => void) { term.data = callback; },
    onExit(callback: (event: { exitCode: number }) => void) { term.exit = callback; },
  };
  return term;
}

describe("TerminalManager", () => {
  it("coalesces opens, ignores the old PTY's output and exit, and accepts input on its replacement", async () => {
    const events = { data: vi.fn(), exit: vi.fn() }, manager = new TerminalManager(events);
    const old = pty(), next = pty();
    spawn.mockReset().mockReturnValueOnce(old).mockReturnValueOnce(next);
    await Promise.all([manager.open("p", null, 80, 24), manager.open("p", null, 90, 32)]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(old.resize).toHaveBeenCalledWith(90, 32);
    manager.close("p");
    await manager.open("p", null, 100, 40);
    old.data("old"); old.exit({ exitCode: 1 });
    manager.write("p", "pwd\r"); next.data("project");
    expect(events.data.mock.calls).toEqual([["p", "project"]]);
    expect(next.write).toHaveBeenCalledWith("pwd\r");
    expect(events.exit).not.toHaveBeenCalled();
    next.exit({ exitCode: 0 });
    expect(events.exit.mock.calls).toEqual([["p", 0]]);
    manager.dispose();
  });

  it("a cancelled pair of opens cannot spawn or resize a later session", async () => {
    const manager = new TerminalManager({ data: vi.fn(), exit: vi.fn() });
    const next = pty();
    spawn.mockReset().mockReturnValue(next);
    const first = manager.open("p", null, 80, 24), joined = manager.open("p", null, 90, 32);
    manager.close("p");
    await Promise.all([manager.open("p", null, 100, 40), first, joined]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(next.resize).not.toHaveBeenCalled();
    manager.dispose();
    expect(next.kill).toHaveBeenCalledOnce();
  });
});
