import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_GUARD } from "../src/main/guard";
import { backgroundsItself, shellTools } from "../src/main/shell-tools";
import { ShellLimitError, ShellManager, type ShellInfo, type ShellManagerOptions } from "../src/main/shells";
import { tempDir } from "./helpers";

const posix = process.platform !== "win32";
/** A node script as a command line, so the tests don't depend on shell tools. */
const nodeCmd = (script: string): string => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
const SERVER = nodeCmd('console.log("ready"); setInterval(() => {}, 1000)');

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let managers: ShellManager[] = [];
const make = (o: ShellManagerOptions = {}): ShellManager => {
  const m = new ShellManager(o);
  managers.push(m);
  return m;
};
afterEach(() => {
  for (const m of managers) m.dispose();
  managers = [];
});

describe("ShellManager", () => {
  it("keeps a server running, reads its output, and stops it", async () => {
    const m = make();
    const info = m.start("t1", tempDir(), SERVER, "dev server");
    expect(info).toMatchObject({ threadId: "t1", name: "dev server", status: "running" });
    expect(info.id).toMatch(/^sh-[0-9a-f]{6}$/);
    await until(() => (m.output(info.id)?.text ?? "").includes("ready"));
    expect(m.get(info.id)?.status).toBe("running");
    const stopped = await m.stop(info.id);
    expect(stopped?.status).toBe("stopped");
    if (posix) await until(() => !alive(info.pid!));
  });

  it("marks a command that ends on its own as exited, with its code", async () => {
    const changes: ShellInfo[] = [];
    const m = make({ onChange: (i) => changes.push(i) });
    const info = m.start("t1", tempDir(), nodeCmd("process.exit(3)"));
    await until(() => m.get(info.id)?.status === "exited");
    expect(m.get(info.id)).toMatchObject({ status: "exited", exitCode: 3 });
    expect(changes.map((c) => c.status)).toEqual(["running", "exited"]);
  });

  it("returns only new output when read from the last offset", async () => {
    const m = make();
    const info = m.start("t1", tempDir(), nodeCmd('console.log("one"); setTimeout(() => console.log("two"), 300); setInterval(() => {}, 1000)'));
    await until(() => (m.output(info.id)?.text ?? "").includes("one"));
    const first = m.output(info.id, { since: 0 })!;
    expect(first.text).toContain("one");
    await until(() => (m.output(info.id)?.text ?? "").includes("two"));
    const second = m.output(info.id, { since: first.next })!;
    expect(second.text).toContain("two");
    expect(second.text).not.toContain("one");
  });

  it("keeps only the last bufferChars and says when older output was dropped", async () => {
    const m = make({ bufferChars: 100 });
    const info = m.start("t1", tempDir(), nodeCmd('for (let i = 0; i < 100; i++) console.log("line" + String(i).padStart(4, "0"))'));
    await until(() => m.get(info.id)?.status === "exited");
    await until(() => (m.output(info.id)?.text ?? "").includes("line0099"));
    const all = m.output(info.id, { since: 0 })!;
    expect(all.dropped).toBe(true);
    expect(all.text.length).toBeLessThanOrEqual(100);
    expect(m.output(info.id, { tail: 2 })!.text).toBe("line0098\nline0099");
  });

  it("refuses past the per-thread and app-wide limits", () => {
    const m = make({ maxPerThread: 1, maxTotal: 2 });
    m.start("t1", tempDir(), SERVER);
    expect(() => m.start("t1", tempDir(), SERVER)).toThrow(ShellLimitError);
    m.start("t2", tempDir(), SERVER);
    expect(() => m.start("t3", tempDir(), SERVER)).toThrow("2 background shells are running");
  });

  it("stops one thread's shells, or those under a folder, and leaves the rest", async () => {
    const m = make();
    const a = tempDir();
    const b = tempDir();
    mkdirSync(join(a, "sub"));
    const t1 = m.start("t1", a, SERVER);
    const t2 = m.start("t2", b, SERVER);
    const t3 = m.start("t3", join(a, "sub"), SERVER);
    await m.stopThread("t1");
    expect(m.get(t1.id)?.status).toBe("stopped");
    expect(m.get(t2.id)?.status).toBe("running");
    await m.stopUnder(a);
    expect(m.get(t3.id)?.status).toBe("stopped");
    expect(m.get(t2.id)?.status).toBe("running");
  });

  it.skipIf(!posix)("kills the whole process tree, not just the shell", async () => {
    const m = make();
    const script = 'const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log("child " + c.pid); setInterval(() => {}, 1000)';
    const info = m.start("t1", tempDir(), nodeCmd(script));
    await until(() => /child \d+/.test(m.output(info.id)?.text ?? ""));
    const child = Number(/child (\d+)/.exec(m.output(info.id)!.text)![1]);
    expect(alive(child)).toBe(true);
    await m.stop(info.id);
    await until(() => !alive(child));
  });

  it("lists a thread's shells newest first", () => {
    const m = make();
    const first = m.start("t1", tempDir(), SERVER);
    const second = m.start("t1", tempDir(), SERVER);
    m.start("t2", tempDir(), SERVER);
    expect(m.list("t1").map((s) => s.id)).toEqual([second.id, first.id]);
    expect(m.list()).toHaveLength(3);
  });
});

describe("shell tools", () => {
  const tools = (manager: ShellManager, threadId: string, dir: string) => shellTools(threadId, { manager, cwdOf: () => dir, guardScript: BUILT_IN_GUARD, initialWaitMs: 1500 });
  const call = async (list: ReturnType<typeof tools>, name: string, args: Record<string, unknown>) => list.find((t) => t.name === name)!.run(args as never);

  it("starts, reads, lists and stops a shell for its own thread only", async () => {
    const m = make();
    const dir = tempDir();
    const mine = tools(m, "t1", dir);
    const started = await call(mine, "shell_start", { command: SERVER, name: "dev" });
    expect(started.isError).toBeFalsy();
    expect(started.text).toContain('Started shell sh-');
    expect(started.text).toContain("ready");
    const id = /shell (sh-[0-9a-f]{6})/.exec(started.text)![1]!;

    const out = await call(mine, "shell_output", { id });
    expect(out.text).toContain(`Shell ${id} ("dev"): running`);
    expect(out.text).toMatch(/--- next: \d+ ---/);
    expect((await call(mine, "shell_list", {})).text).toContain(id);

    const other = tools(m, "t2", dir);
    expect(await call(other, "shell_output", { id })).toMatchObject({ isError: true, text: `No shell ${id} in this thread.` });
    expect(await call(other, "shell_stop", { id })).toMatchObject({ isError: true });
    expect(m.get(id)?.status).toBe("running");

    expect((await call(mine, "shell_stop", { id })).text).toBe(`Stopped shell ${id} ("dev").`);
    expect((await call(mine, "shell_stop", { id })).text).toContain("had already exited");
  });

  it("refuses a command the git guardrail blocks", async () => {
    const res = await call(tools(make(), "t1", tempDir()), "shell_start", { command: "git push --force origin main" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("guardrail");
  });

  it("says when the thread has no shells", async () => {
    expect((await call(tools(make(), "t1", tempDir()), "shell_list", {})).text).toBe("No background shells in this thread.");
  });
});

describe("tool server ?s=", () => {
  it("adds a thread's shell tools only when ?s= names it", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const { startToolServer, withShells } = await import("../src/main/mcp-http");
    const { closeAfter } = await import("./helpers");
    const manager = make();
    const base = { name: "base", description: "base", input: {}, autoAllow: true, run: async () => ({ text: "base" }) };
    const server = await startToolServer(() => [base], undefined, undefined, undefined, undefined, undefined, undefined, undefined, (tid) =>
      shellTools(tid, { manager, cwdOf: () => tempDir(), guardScript: BUILT_IN_GUARD }),
    );
    closeAfter(() => void server.close());
    const connect = async (url: string) => {
      const client = new Client({ name: "test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }));
      return client;
    };
    const plain = await connect(server.url);
    expect((await plain.listTools()).tools.map((t) => t.name)).toEqual(["base"]);
    await plain.close();
    const withThread = await connect(withShells(server.url, "t1"));
    expect((await withThread.listTools()).tools.map((t) => t.name)).toEqual(["base", "shell_start", "shell_output", "shell_stop", "shell_list"]);
    await withThread.close();
  });
});

describe("backgroundsItself", () => {
  it("spots a job sent to the background", () => {
    for (const c of ["python3 -m http.server 8000 &", "bun run dev & sleep 2 && curl localhost:3000", "nohup node server.js > log 2>&1", "setsid ./run.sh", "./x & disown"]) expect(backgroundsItself(c)).toBe(true);
  });
  it("leaves && chains and redirections alone", () => {
    for (const c of ["bun install && bun run build", "make 2>&1 | tee log", "cmd &> out.txt", "echo a || echo b", "grep -c '&amp;' page.html"]) expect(backgroundsItself(c)).toBe(false);
  });
});
