import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import { KIT_HOSTS, type KitCatalogEntry } from "../src/main/design/kit-catalog";
import { fetchKitArchive, KitInstallError, KitStore, unpackKitArchive } from "../src/main/design/kit-install";

const MAX_BYTES = 4 * 1024 * 1024;

/** A catalog entry whose url and hash the caller lines up with the zip it serves. */
function entry(over: Partial<KitCatalogEntry> = {}): KitCatalogEntry {
  return { id: "test-kit", name: "Test", version: "1.0.0", url: "https://github.com/x/y/releases/download/v1/kit.zip", sha256: "0".repeat(64), ...over };
}

/** The files a valid kit holds, so validateKitDir passes for real (never mocked). */
const KIT_FILES: Record<string, string> = {
  "index.md": "---\ntype: design-kit\nname: Test\n---\n",
  "DESIGN.md": "# Test\n",
  "tokens.css": ":root { --color-bg: #fff; --color-text: #000; }\n",
  "ui.css": '[data-ui="button"] { padding: 4px; }\n',
  "components.json": JSON.stringify({
    kitId: "test-kit",
    name: "Test",
    version: "1.0.0",
    contractVersion: "1.0",
    compat: { themes: ["*"], migratesFrom: [] },
    components: [{ name: "Button", ui: "button", snippet: '<button data-ui="button">Go</button>' }],
  }),
};

/** A kit's files with a different declared version. */
function kitFiles(version: string): Record<string, string> {
  const files = { ...KIT_FILES };
  files["components.json"] = JSON.stringify({ ...JSON.parse(KIT_FILES["components.json"]!), version });
  return files;
}

/** Build a real zip from a file map. */
async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

/** Raw bytes of a zip built by hand, for entries JSZip's builder cannot express. */
async function rawZip(build: (zip: JSZip) => void, platform: "DOS" | "UNIX" = "DOS"): Promise<Uint8Array> {
  const zip = new JSZip();
  build(zip);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", platform }));
}

/** A fetch that serves one response and records every URL it was asked for. */
function fakeFetch(handler: (url: string) => Response | Promise<Response>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** Every file under `dir`, relative, sorted. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  if (existsSync(dir)) walk("");
  return out.sort();
}

/** The code a rejection carries, asserting it is our error type. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof KitInstallError)) throw error;
    return error.code;
  }
  throw new Error("expected a rejection");
}

describe("fetchKitArchive", () => {
  it("follows an allowed https redirect", async () => {
    const target = new TextEncoder().encode("hello");
    const { fetch, calls } = fakeFetch((url) =>
      url === "https://github.com/a.zip"
        ? new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/b.zip" } })
        : new Response(target, { status: 200 }),
    );
    const bytes = await fetchKitArchive("https://github.com/a.zip", { hosts: KIT_HOSTS, maxBytes: MAX_BYTES, fetch });
    expect([...bytes]).toEqual([...target]);
    expect(calls).toEqual(["https://github.com/a.zip", "https://objects.githubusercontent.com/b.zip"]);
  });

  it.each<[string, string, string | null]>([
    ["an http url", "http://github.com/x", null],
    ["a file url", "file:///x", null],
    ["an outside host", "https://evil.example/x", null],
    ["a redirect to http", "https://github.com/x", "http://github.com/x"],
    ["a redirect to an outside host", "https://github.com/x", "https://evil.example/x"],
    ["a redirect to file", "https://github.com/x", "file:///etc/passwd"],
    ["credentials in the url", "https://user:pass@github.com/x", null],
  ])("refuses %s", async (_label, first, location) => {
    const { fetch, calls } = fakeFetch((url) =>
      location && url === first ? new Response(null, { status: 302, headers: { location } }) : new Response(new Uint8Array([1]), { status: 200 }),
    );
    expect(await codeOf(fetchKitArchive(first, { hosts: KIT_HOSTS, maxBytes: MAX_BYTES, fetch }))).toBe("blocked");
    // The bad target never reaches the network.
    expect(calls).toEqual(location ? ["https://github.com/x"] : []);
  });

  it("refuses too many redirects", async () => {
    const { fetch } = fakeFetch((url) => new Response(null, { status: 302, headers: { location: `${url}/next` } }));
    expect(await codeOf(fetchKitArchive("https://github.com/r0", { hosts: KIT_HOSTS, maxBytes: MAX_BYTES, fetch }))).toBe("blocked");
  });

  it("reports a 500 as offline", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 500 }));
    expect(await codeOf(fetchKitArchive("https://github.com/x", { hosts: KIT_HOSTS, maxBytes: MAX_BYTES, fetch }))).toBe("offline");
  });

  it("reports a thrown fetch as offline", async () => {
    const { fetch } = fakeFetch(() => {
      throw new Error("boom");
    });
    expect(await codeOf(fetchKitArchive("https://github.com/x", { hosts: KIT_HOSTS, maxBytes: MAX_BYTES, fetch }))).toBe("offline");
  });

  it("refuses a content-length over the limit", async () => {
    const { fetch } = fakeFetch(() => new Response(new Uint8Array(10), { status: 200, headers: { "content-length": "999999" } }));
    expect(await codeOf(fetchKitArchive("https://github.com/x", { hosts: KIT_HOSTS, maxBytes: 1000, fetch }))).toBe("archive");
  });

  it("refuses a body over the limit with no content-length", async () => {
    const big = new Uint8Array(5000);
    const { fetch } = fakeFetch(() => new Response(big, { status: 200 }));
    expect(await codeOf(fetchKitArchive("https://github.com/x", { hosts: KIT_HOSTS, maxBytes: 1000, fetch }))).toBe("archive");
  });

  it("asks for manual redirects and no credentials", async () => {
    const seen: RequestInit[] = [];
    const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as typeof fetch;
    await fetchKitArchive("https://github.com/x", { hosts: KIT_HOSTS, maxBytes: MAX_BYTES, fetch: fake });
    expect(seen[0]?.redirect).toBe("manual");
    expect(seen[0]?.credentials).toBe("omit");
  });
});

describe("unpackKitArchive", () => {
  it("unpacks a good zip byte for byte", async () => {
    const bytes = await zipOf(KIT_FILES);
    const dest = join(tempDir(), "kit");
    await unpackKitArchive(bytes, dest);
    for (const [name, text] of Object.entries(KIT_FILES)) expect(readFileSync(join(dest, name), "utf-8")).toBe(text);
  });

  it("refuses bytes that are not a zip", async () => {
    const dest = join(tempDir(), "kit");
    expect(await codeOf(unpackKitArchive(new TextEncoder().encode("not a zip at all"), dest))).toBe("archive");
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses too many entries", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4000; i++) files[`f${i}.css`] = "x";
    const dest = join(tempDir(), "kit");
    expect(await codeOf(unpackKitArchive(await zipOf(files), dest))).toBe("archive");
    expect(listFiles(dest)).toEqual([]);
  });

  it("refuses an .exe", async () => {
    const dest = join(tempDir(), "kit");
    expect(await codeOf(unpackKitArchive(await zipOf({ ...KIT_FILES, "tool.exe": "MZ" }), dest))).toBe("archive");
    expect(listFiles(dest)).toEqual([]);
  });

  it("refuses a dotfile", async () => {
    const dest = join(tempDir(), "kit");
    expect(await codeOf(unpackKitArchive(await zipOf({ ...KIT_FILES, ".env": "SECRET=1" }), dest))).toBe("archive");
    expect(listFiles(dest)).toEqual([]);
  });

  it("refuses a symlink entry", async () => {
    const bytes = await rawZip((zip) => {
      for (const [name, text] of Object.entries(KIT_FILES)) zip.file(name, text);
      zip.file("link.css", "/etc/passwd", { unixPermissions: 0o120777 });
    }, "UNIX");
    const dest = join(tempDir(), "kit");
    expect(await codeOf(unpackKitArchive(bytes, dest))).toBe("archive");
    expect(listFiles(dest)).toEqual([]);
  });

  it("refuses names that collide ignoring case", async () => {
    const dest = join(tempDir(), "kit");
    expect(await codeOf(unpackKitArchive(await zipOf({ ...KIT_FILES, "A.css": "a", "a.css": "b" }), dest))).toBe("archive");
    expect(listFiles(dest)).toEqual([]);
  });

  it("refuses deep paths", async () => {
    const dest = join(tempDir(), "kit");
    const deep = `${Array.from({ length: 40 }, () => "d").join("/")}/x.css`;
    expect(await codeOf(unpackKitArchive(await zipOf({ ...KIT_FILES, [deep]: "x" }), dest))).toBe("archive");
    expect(listFiles(dest)).toEqual([]);
  });

  it("refuses an oversize file", async () => {
    // 9 MiB of zeros compresses to almost nothing, so either the declared size or the ratio refuses it.
    const bomb = new Uint8Array(9 * 1024 * 1024);
    const dest = join(tempDir(), "kit");
    expect(await codeOf(unpackKitArchive(await zipOf({ ...KIT_FILES, "bomb.css": bomb }), dest))).toBe("archive");
    expect(listFiles(dest)).toEqual([]);
  });

  it("refuses path traversal and writes nothing outside", async () => {
    const root = tempDir();
    const dest = join(root, "kit");
    expect(await codeOf(unpackKitArchive(await zipOf({ ...KIT_FILES, "../evil.css": "x" }), dest))).toBe("archive");
    expect(existsSync(join(root, "evil.css"))).toBe(false);
    expect(listFiles(dest)).toEqual([]);
  });
});

describe("KitStore", () => {
  /** A store in a fresh folder, plus a catalog entry whose hash matches `files`. */
  async function storeWith(files: Record<string, string>, over: Partial<KitCatalogEntry> = {}) {
    const bytes = await zipOf(files);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { store: new KitStore(tempDir()), bytes, catalogEntry: { ...entry(over), sha256 } };
  }

  /** A fake fetch that always serves `bytes`. */
  function serve(bytes: Uint8Array) {
    return fakeFetch(() => new Response(bytes as BodyInit, { status: 200 }));
  }

  it("installs a good kit and points at it", async () => {
    const { store, bytes, catalogEntry } = await storeWith(KIT_FILES);
    const { fetch } = serve(bytes);
    const result = await store.install(catalogEntry, { fetch });
    expect(result.reused).toBe(false);
    expect(existsSync(join(result.dir, "ui.css"))).toBe(true);
    expect(result.dir.endsWith(join("kits", "test-kit@1.0.0"))).toBe(true);
    expect(store.active()["test-kit"]?.version).toBe("1.0.0");
    expect(store.activeDir("test-kit")).toBe(result.dir);
  });

  it("reuses an installed version without fetching", async () => {
    const { store, bytes, catalogEntry } = await storeWith(KIT_FILES);
    await store.install(catalogEntry, { fetch: serve(bytes).fetch });
    const second = serve(bytes);
    const again = await store.install(catalogEntry, { fetch: second.fetch });
    expect(again.reused).toBe(true);
    expect(second.calls).toEqual([]);
  });

  it("refuses a wrong hash and leaves the previous state", async () => {
    const { store, bytes, catalogEntry } = await storeWith(KIT_FILES);
    const before = store.active();
    const bad = { ...catalogEntry, sha256: "f".repeat(64) };
    expect(await codeOf(store.install(bad, { fetch: serve(bytes).fetch }))).toBe("hash");
    expect(store.active()).toEqual(before);
    expect(listFiles(join((store as unknown as { packsDir: string }).packsDir, "staging"))).toEqual([]);
  });

  it("refuses a kit that fails validation and keeps the old version", async () => {
    const first = await storeWith(KIT_FILES);
    await first.store.install(first.catalogEntry, { fetch: serve(first.bytes).fetch });

    const broken = { ...KIT_FILES };
    delete broken["ui.css"];
    const next = await storeWith(broken, { version: "1.1.0" });
    const code = await codeOf(first.store.install(next.catalogEntry, { fetch: serve(next.bytes).fetch }));
    expect(code).toBe("invalid");
    expect(first.store.active()["test-kit"]?.version).toBe("1.0.0");
    const dir = first.store.activeDir("test-kit");
    expect(dir).not.toBeNull();
    expect(existsSync(join(dir!, "ui.css"))).toBe(true);
  });

  it("refuses a version mismatch", async () => {
    const { store, bytes, catalogEntry } = await storeWith(kitFiles("2.0.0"));
    expect(await codeOf(store.install({ ...catalogEntry, version: "1.0.0" }, { fetch: serve(bytes).fetch }))).toBe("invalid");
    expect(store.active()["test-kit"]).toBeUndefined();
  });

  it("refuses a bad id without fetching", async () => {
    const { store, bytes, catalogEntry } = await storeWith(KIT_FILES);
    const net = serve(bytes);
    expect(await codeOf(store.install({ ...catalogEntry, id: "../x" }, { fetch: net.fetch }))).toBe("invalid");
    expect(net.calls).toEqual([]);
  });

  it("refuses a downgrade", async () => {
    const one = await storeWith(KIT_FILES);
    await one.store.install(one.catalogEntry, { fetch: serve(one.bytes).fetch });
    const older = await storeWith(kitFiles("0.9.0"), { version: "0.9.0" });
    expect(await codeOf(one.store.install(older.catalogEntry, { fetch: serve(older.bytes).fetch }))).toBe("invalid");
    expect(one.store.active()["test-kit"]?.version).toBe("1.0.0");
  });

  it("switches the pointer on upgrade and removes the old folder", async () => {
    const first = await storeWith(KIT_FILES);
    const installed = await first.store.install(first.catalogEntry, { fetch: serve(first.bytes).fetch });
    const next = await storeWith(kitFiles("1.1.0"), { version: "1.1.0" });
    const second = await first.store.install(next.catalogEntry, { fetch: serve(next.bytes).fetch });
    expect(second.reused).toBe(false);
    expect(first.store.active()["test-kit"]?.version).toBe("1.1.0");
    expect(first.store.activeDir("test-kit")).toBe(second.dir);
    expect(existsSync(installed.dir)).toBe(false);
  });

  it("cleanStaging removes leftovers and keeps kits", async () => {
    const { store, bytes, catalogEntry } = await storeWith(KIT_FILES);
    const installed = await store.install(catalogEntry, { fetch: serve(bytes).fetch });
    const packsDir = (store as unknown as { packsDir: string }).packsDir;
    mkdirSync(join(packsDir, "staging", "leftover"), { recursive: true });
    writeFileSync(join(packsDir, "staging", "leftover", "x"), "x");
    store.cleanStaging();
    expect(existsSync(join(packsDir, "staging", "leftover"))).toBe(false);
    expect(existsSync(installed.dir)).toBe(true);
    expect(store.active()["test-kit"]?.version).toBe("1.0.0");
  });

  it("reads a corrupt active.json as empty", async () => {
    const packsDir = tempDir();
    writeFileSync(join(packsDir, "active.json"), "{not json");
    expect(new KitStore(packsDir).active()).toEqual({});
  });
});

describe("names and pointers a hostile kit could use", () => {
  const WINDOWS_NAMES = ["a.css:evil.css", "CON.css", "nul.html", "folder/aux.md", "trailing.css.", "lpt1.css", 'quo"te.css', "star*.css"];

  for (const name of WINDOWS_NAMES) {
    it(`refuses ${name} on every platform`, async () => {
      const zip = new JSZip();
      zip.file(name, "x");
      const dest = tempDir();
      await expect(unpackKitArchive(await zip.generateAsync({ type: "uint8array" }), dest)).rejects.toMatchObject({ code: "archive" });
      expect(readdirSync(dest)).toEqual([]);
    });
  }

  it("refuses two entries with the same name, which JSZip alone would hide", async () => {
    const zip = new JSZip();
    zip.file("a.css", "first");
    zip.file("b.css", "second");
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
    // Rename b.css to a.css in place, in both its local header and the central directory.
    const text = Buffer.from(bytes).toString("latin1");
    let at = text.indexOf("b.css");
    let renamed = 0;
    while (at !== -1) {
      bytes[at] = "a".charCodeAt(0);
      renamed++;
      at = text.indexOf("b.css", at + 1);
    }
    expect(renamed).toBe(2);
    const dest = tempDir();
    await expect(unpackKitArchive(bytes, dest)).rejects.toMatchObject({ code: "archive" });
    expect(readdirSync(dest)).toEqual([]);
  });

  it("ignores a pointer whose id or version would step outside the kits folder", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "active.json"),
      JSON.stringify({
        "../evil": { version: "1.0.0", sha256: "a", source: "x" },
        good: { version: "../../evil", sha256: "a", source: "x" },
        fine: { version: "1.0.0", sha256: "a", source: "x" },
      }),
    );
    const store = new KitStore(dir);
    expect(Object.keys(store.active())).toEqual(["fine"]);
    expect(store.activeDir("good")).toBeNull();
    expect(store.activeDir("../evil")).toBeNull();
  });

  it("lets an aborted download stay an abort rather than calling the kit invalid", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = (async () => {
      throw new DOMException("Aborted", "AbortError");
    }) as unknown as typeof fetch;
    const entry = { id: "test-kit", name: "Test", version: "1.0.0", url: "https://github.com/x", sha256: "a".repeat(64) };
    await expect(new KitStore(tempDir()).install(entry, { fetch: fetcher, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
