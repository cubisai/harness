// P5.5a: finding a project's dev server, starting one the app owns, and
// stopping only the ones it started. No npm runs: spawn is injected.

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectScripts, inferPort, packageManager } from "../src/main/devserver/detect";
import { DevServers, portOpen, type OwnedServer } from "../src/main/devserver/registry";
import { devServerTools } from "../src/main/devserver/tools";
import { closeAfter, tempDir } from "./helpers";

/** A free loopback port: bind port 0, read it, release it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

/** A `node -e` dev-server double: listens on the given port and stays up. */
function listenChild(port: number, children: ChildProcess[]): ChildProcess {
  const src = `require("node:http").createServer((_, res) => res.end("ok")).listen(${port}, "127.0.0.1", () => console.log("ready"));`;
  const child = spawn(process.execPath, ["-e", src], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  children.push(child);
  return child;
}

async function waitUntil(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

function project(scripts: Record<string, string>, locks: string[] = []): string {
  const dir = tempDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
  for (const lock of locks) writeFileSync(join(dir, lock), "");
  return dir;
}

describe("packageManager", () => {
  it("picks the manager by lockfile, npm by default", () => {
    expect(packageManager(project({ dev: "vite" }, ["bun.lock"]))).toBe("bun");
    expect(packageManager(project({ dev: "vite" }, ["bun.lockb"]))).toBe("bun");
    expect(packageManager(project({ dev: "vite" }, ["pnpm-lock.yaml"]))).toBe("pnpm");
    expect(packageManager(project({ dev: "vite" }, ["yarn.lock"]))).toBe("yarn");
    expect(packageManager(project({ dev: "vite" }))).toBe("npm");
  });
});

describe("inferPort", () => {
  it("reads an explicit port before the tool's default", () => {
    expect(inferPort("vite --port 4000", "dev")).toBe(4000);
    expect(inferPort("vite --port=4001", "dev")).toBe(4001);
    expect(inferPort("next dev -p 4002", "dev")).toBe(4002);
    expect(inferPort("PORT=8081 node server.js", "start")).toBe(8081);
  });

  it("knows each tool's default port", () => {
    expect(inferPort("vite", "dev")).toBe(5173);
    expect(inferPort("vite preview", "preview")).toBe(4173);
    expect(inferPort("vite preview", "dev")).toBe(4173);
    expect(inferPort("vite", "preview")).toBe(4173);
    expect(inferPort("next dev", "dev")).toBe(3000);
    expect(inferPort("react-scripts start", "start")).toBe(3000);
    expect(inferPort("astro dev", "dev")).toBe(4321);
    expect(inferPort("nuxt dev", "dev")).toBe(3000);
    expect(inferPort("webpack serve", "dev")).toBe(8080);
    expect(inferPort("webpack-dev-server", "dev")).toBe(8080);
    expect(inferPort("remix dev", "dev")).toBe(3000);
    expect(inferPort("ng serve", "dev")).toBe(4200);
    expect(inferPort("node server.js", "start")).toBe(3000);
  });
});

describe("detectScripts", () => {
  it("detects each candidate with its command and port", () => {
    expect(detectScripts(project({ dev: "vite", preview: "vite preview" }))).toEqual([
      { script: "dev", command: "vite", port: 5173 },
      { script: "preview", command: "vite preview", port: 4173 },
    ]);
    expect(detectScripts(project({ dev: "next dev" }))).toEqual([{ script: "dev", command: "next dev", port: 3000 }]);
    expect(detectScripts(project({ dev: "vite --port 4000" }))).toEqual([{ script: "dev", command: "vite --port 4000", port: 4000 }]);
    expect(detectScripts(project({ start: "PORT=8081 node server.js" }))).toEqual([{ script: "start", command: "PORT=8081 node server.js", port: 8081 }]);
  });

  it("skips build-only and test scripts", () => {
    expect(detectScripts(project({ dev: "vite build" }))).toEqual([]);
    expect(detectScripts(project({ start: "node --test" }))).toEqual([]);
  });

  it("returns [] when there is no package.json", () => {
    expect(detectScripts(tempDir())).toEqual([]);
  });
});

describe("portOpen", () => {
  it("sees a listening server and not one after it closes", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    expect(await portOpen(port)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await portOpen(port)).toBe(false);
  });
});

describe("DevServers", () => {
  it("starts a server, lists it, then stops it", async () => {
    const port = await freePort();
    const children: ChildProcess[] = [];
    closeAfter(() => {
      for (const c of children) {
        try {
          c.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });
    const servers = new DevServers({ spawn: () => listenChild(port, children), readyTimeoutMs: 5000 });
    const started = await servers.start("p", tempDir(), { script: "dev", command: "vite", port });
    expect(started.script).toBe("dev");
    expect(started.exited).toBeNull();
    expect(typeof started.pid).toBe("number");
    expect(servers.list("p").map((s) => s.id)).toEqual(["p:dev"]);
    expect(await portOpen(port)).toBe(true);

    expect(servers.stop("p:dev")).toBe(true);
    expect(servers.stop("p:dev")).toBe(false);
    expect(await waitUntil(async () => !(await portOpen(port)), 3000)).toBe(true);
  });

  it("refuses a second start of the same script", async () => {
    const port = await freePort();
    const children: ChildProcess[] = [];
    closeAfter(() => {
      for (const c of children) {
        try {
          c.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });
    const servers = new DevServers({ spawn: () => listenChild(port, children), readyTimeoutMs: 5000 });
    const d = { script: "dev", command: "vite", port };
    await servers.start("p", tempDir(), d);
    await expect(servers.start("p", tempDir(), d)).rejects.toThrow("Already running");
    servers.stopAll();
  });

  it("refuses when the port is already in use", async () => {
    const port = await freePort();
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
    const servers = new DevServers({ spawn: () => listenChild(port, []), readyTimeoutMs: 5000 });
    await expect(servers.start("p", tempDir(), { script: "dev", command: "vite", port })).rejects.toThrow("already in use");
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it("rejects when the process exits before its port opens", async () => {
    const port = await freePort();
    const servers = new DevServers({ spawn: () => spawn(process.execPath, ["-e", "process.exit(2)"], { stdio: ["ignore", "pipe", "pipe"] }), readyTimeoutMs: 5000 });
    await expect(servers.start("p", tempDir(), { script: "dev", command: "vite", port })).rejects.toThrow("exited with code");
  });
});

describe("dev server tools", () => {
  function fakeServers(parts: { list?: OwnedServer[]; open?: boolean } = {}): DevServers {
    return {
      list: () => parts.list ?? [],
      isOpen: async () => parts.open ?? false,
      stop: () => true,
    } as unknown as DevServers;
  }

  it("lists a detected script as not running with its command and port", async () => {
    const dir = project({ dev: "vite" });
    const tools = devServerTools(fakeServers({ open: false }), () => dir);
    const res = await tools[0]!.run({}, { projectId: "p" });
    expect(res.text).toContain("dev");
    expect(res.text).toContain("vite");
    expect(res.text).toContain("port 5173");
    expect(res.text).toContain("not running");
  });

  it("marks an owned server and gives its URL", async () => {
    const dir = project({ dev: "vite" });
    const owned: OwnedServer = { id: "p:dev", projectId: "p", cwd: dir, script: "dev", port: 5173, pid: 4321, startedAt: 1, output: [], exited: null };
    const tools = devServerTools(fakeServers({ list: [owned], open: true }), () => dir);
    const res = await tools[0]!.run({}, { projectId: "p" });
    expect(res.text).toContain("running (owned by CubiQ, pid 4321)");
    expect(res.text).toContain("http://localhost:5173");
  });

  it("refuses to stop a server it didn't start", async () => {
    const dir = project({ dev: "vite" });
    const tools = devServerTools(fakeServers({ open: true }), () => dir);
    const res = await tools[0]!.run({ action: "stop", script: "dev" }, { projectId: "p" });
    expect(res.text).toBe("CubiQ only stops servers it started; dev on port 5173 wasn't.");
  });

  it("needs a project, and start runs a project command through the policy", async () => {
    const dir = project({ dev: "vite" });
    const tools = devServerTools(fakeServers(), () => dir);
    expect(tools.map((t) => t.name)).toEqual(["dev_server", "dev_server_start"]);
    expect(tools[0]!.autoAllow).toBe(true);
    expect(tools[1]!.autoAllow).toBe(false);
    expect(tools[1]!.effect).toBe("mutate");
    expect((await tools[0]!.run({})).text).toBe("No project for this thread.");
    const bad = await tools[1]!.run({ script: "nope" }, { projectId: "p" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("nope");
    expect(bad.text).toContain("dev");
  });
});
