import { describe, expect, it } from "vitest";
import { messageCenterDestination } from "../src/main/automations/destinations";
import type { DeliveryPayload } from "../src/main/automations/io";
import { gitLogSource, defaultSources, type GitExec } from "../src/main/automations/sources";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OLD = "1111111111111111111111111111111111111111";
const REWRITTEN = "beefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
const ctx = { projectId: "p1", cwd: "/repo" };

interface Call {
  command: string;
  args: string[];
  cwd: string;
}

/** A git that answers from a handler and records every invocation. */
function fakeGit(handler: (args: string[]) => string): { exec: GitExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: GitExec = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    return handler(args);
  };
  return { exec, calls };
}

const logArgs = (args: string[]): boolean => args[0] === "log";

describe("gitLogSource", () => {
  it("reads the last 20 on a first run and advances to HEAD", async () => {
    const { exec, calls } = fakeGit((args) => {
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      return `${HEAD}\tnewest\n${OLD}\tolder\n`;
    });

    const read = await gitLogSource(exec).read(null, ctx);

    expect(read).toEqual({ items: [`${HEAD.slice(0, 7)} newest`, `${OLD.slice(0, 7)} older`], next: HEAD });
    const log = calls.find((c) => logArgs(c.args));
    expect(log).toEqual({ command: "git", args: ["log", "--format=%H%x09%s", "-n", "20", "HEAD"], cwd: "/repo" });
  });

  it("formats each item as a 7-char sha and the subject", async () => {
    const { exec } = fakeGit((args) => (args[0] === "rev-parse" ? HEAD : `${HEAD}\t fix: thing\n`));
    const read = await gitLogSource(exec).read(null, ctx);
    expect(read.items).toEqual([`${HEAD.slice(0, 7)}  fix: thing`]);
    expect(read.items[0]!.slice(0, 7)).toBe(HEAD.slice(0, 7));
  });

  it("reads an incremental range with -n 50", async () => {
    const { exec, calls } = fakeGit((args) => {
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      return `${REWRITTEN}\tone\n`;
    });

    const read = await gitLogSource(exec).read(OLD, ctx);

    expect(read).toEqual({ items: [`${REWRITTEN.slice(0, 7)} one`], next: HEAD });
    expect(calls.find((c) => logArgs(c.args))!.args).toEqual(["log", "--format=%H%x09%s", "-n", "50", `${OLD}..HEAD`]);
  });

  it("reports nothing new when HEAD is the bookmark", async () => {
    const { exec, calls } = fakeGit(() => `${HEAD}\n`);

    const read = await gitLogSource(exec).read(HEAD, ctx);

    expect(read).toEqual({ items: [], next: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["rev-parse", "HEAD"]);
  });

  it("rejects with 'not a git repository' when rev-parse fails", async () => {
    const { exec } = fakeGit(() => {
      throw new Error("fatal: not a git repository (or any parent)");
    });

    await expect(gitLogSource(exec).read(null, ctx)).rejects.toThrow("not a git repository: /repo");
  });

  it("falls back to the last 20 when the bookmark range is gone", async () => {
    const { exec, calls } = fakeGit((args) => {
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      if (args.some((a) => a.includes("..HEAD"))) throw new Error("fatal: bad revision");
      return `${HEAD}\trecovered\n`;
    });

    const read = await gitLogSource(exec).read(OLD, ctx);

    expect(read).toEqual({ items: [`${HEAD.slice(0, 7)} recovered`], next: HEAD });
    const logs = calls.filter((c) => logArgs(c.args)).map((c) => c.args);
    expect(logs).toEqual([
      ["log", "--format=%H%x09%s", "-n", "50", `${OLD}..HEAD`],
      ["log", "--format=%H%x09%s", "-n", "20", "HEAD"],
    ]);
  });

  it("lists the git source under defaultSources", () => {
    const sources = defaultSources();
    expect([...sources.keys()]).toEqual(["git"]);
    expect(sources.get("git")!.id).toBe("git");
  });
});

describe("messageCenterDestination", () => {
  const payload = (key: string): DeliveryPayload => ({ key, automationId: "a1", runId: 1, threadId: "t1", title: "T", text: "B" });

  it("delivers once per key and returns the receipt", async () => {
    const seen: string[] = [];
    const dest = messageCenterDestination((p) => seen.push(p.key));

    expect(dest.id).toBe("message-center");
    expect(await dest.publish(payload("k1"))).toBe("k1");
    expect(await dest.publish(payload("k1"))).toBe("k1");
    await dest.publish(payload("k2"));

    expect(seen).toEqual(["k1", "k2"]);
  });

  it("checks confirmed for a key it delivered and missing otherwise", async () => {
    const dest = messageCenterDestination(() => {});

    expect(await dest.check("k1")).toBe("missing");
    await dest.publish(payload("k1"));
    expect(await dest.check("k1")).toBe("confirmed");
  });
});
