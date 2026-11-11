import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";
import {
  isReferenceSlug,
  parseReferenceIndex,
  REFERENCE_FILE_MAX,
  REFERENCE_ORIGIN,
  REFERENCE_VARIANTS,
  ReferenceDownloadError,
  ReferenceStore,
  referenceUrl,
  type ReferenceIndexEntry,
  type ReferenceVariant,
} from "../src/main/design/references-store";

const SLUGS = ["alpha", "beta", "gamma"] as const;
const LIBRARY_URL = `${REFERENCE_ORIGIN}/library.json`;

/** A short synthetic style document, never real GradientDeck content. */
function markdownFor(slug: string, variant: ReferenceVariant): string {
  return `# ${slug}\n\n## Tokens — Colors\n\n${variant}\n`;
}

/** Every synthetic Markdown body, keyed by the URL that serves it. */
function bodies(): Map<string, string> {
  const map = new Map<string, string>();
  for (const slug of SLUGS) for (const variant of REFERENCE_VARIANTS) map.set(referenceUrl(slug, variant), markdownFor(slug, variant));
  return map;
}

/** A synthetic index entry. */
function entry(slug: string, over: Partial<ReferenceIndexEntry> = {}): ReferenceIndexEntry {
  return {
    slug,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    theme: "dark",
    colors: [{ name: "Ink", hex: "#111111" }],
    ...over,
  };
}

/** A fetch that serves one response and records every URL it was asked for. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** Serve an index and a body for each Markdown URL; anything else is a 404. */
function serve(index: string, map: Map<string, string>): { fetch: typeof fetch; calls: string[] } {
  return fakeFetch((url) => {
    if (url === LIBRARY_URL) return new Response(index);
    const body = map.get(url);
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(body);
  });
}

/** Every half-written file under `dir`, relative, sorted. */
function partFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const entries = (() => {
      try {
        return readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true });
      } catch {
        return [];
      }
    })();
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith(".part")) out.push(child);
    }
  };
  walk("");
  return out.sort();
}

/** The code a rejection carries, asserting it is our error type. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ReferenceDownloadError)) throw error;
    return error.code;
  }
  throw new Error("expected a rejection");
}

describe("parseReferenceIndex", () => {
  it("keeps only the fields it uses and drops bad entries", () => {
    const raw = JSON.stringify([
      {
        slug: "hifi",
        name: "HIFI",
        nickname: "Lemon cursor in a blacked-out terminal",
        industry: "fintech",
        theme: "dark",
        host: "hifi.com",
        cover_asset: { url: "https://x/cover.png" },
        video: "https://x/video.mp4",
        icon: { name: "dot" },
        tone: { voice: "dry" },
        colors: [
          { id: "lemon-signal", name: "Lemon Signal", hex: "#f2ff66" },
          { name: "Not a hex", hex: "lemon" },
          { name: "Short", hex: "#fff" },
        ],
        fonts: ["Inter", { name: "Mono" }, { family: "Serif" }, 7],
      },
      { slug: "../x", name: "Traversal", theme: "dark" },
      { slug: "A B", name: "Space", theme: "dark" },
      { slug: "", name: "Empty", theme: "dark" },
      { slug: "neon", name: "Neon", theme: "neon" },
      { slug: "hifi", name: "Duplicate", theme: "light" },
      { slug: "beta", name: "Beta", theme: "light", colors: [], fonts: [{ family: "Mono" }] },
    ]);

    const entries = parseReferenceIndex(raw);
    expect(entries.map((e) => e.slug)).toEqual(["hifi", "beta"]);
    expect(entries[0]).toEqual({
      slug: "hifi",
      name: "HIFI",
      nickname: "Lemon cursor in a blacked-out terminal",
      industry: "fintech",
      theme: "dark",
      host: "hifi.com",
      colors: [
        { name: "Lemon Signal", hex: "#f2ff66" },
        { name: "Short", hex: "#fff" },
      ],
      fonts: ["Inter", "Mono", "Serif"],
    });
    expect(entries[0]).not.toHaveProperty("cover_asset");
    expect(entries[0]).not.toHaveProperty("video");
    expect(entries[0]).not.toHaveProperty("icon");
    expect(entries[0]).not.toHaveProperty("tone");
    expect(entries[1]?.fonts).toEqual(["Mono"]);
  });

  it("never requests a slug it dropped", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify([
      { slug: "../x", name: "Traversal", theme: "dark" },
      { slug: "A B", name: "Space", theme: "dark" },
      entry("alpha"),
    ]);
    const map = new Map<string, string>([
      [referenceUrl("alpha", "compact"), markdownFor("alpha", "compact")],
      [referenceUrl("alpha", "extended"), markdownFor("alpha", "extended")],
    ]);
    const { fetch, calls } = serve(index, map);

    await store.download({ fetch });

    expect(calls.some((url) => url.includes("../x"))).toBe(false);
    expect(calls.some((url) => url.includes("A%20B"))).toBe(false);
    expect(calls).toContain(referenceUrl("alpha", "compact"));
  });
});

describe("referenceUrl", () => {
  it("builds both variants and refuses a bad slug", () => {
    expect(referenceUrl("hifi", "compact")).toBe(`${REFERENCE_ORIGIN}/styles/hifi/design.md`);
    expect(referenceUrl("hifi", "extended")).toBe(`${REFERENCE_ORIGIN}/styles/hifi/design-extended.md`);
    expect(() => referenceUrl("../etc", "compact")).toThrow(ReferenceDownloadError);
    expect(isReferenceSlug("../etc")).toBe(false);
    expect(isReferenceSlug("hifi")).toBe(true);
  });
});

describe("ReferenceStore", () => {
  it("downloads and saves every file", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    const map = bodies();
    const { fetch, calls } = serve(index, map);

    const status = await store.download({ fetch });
    expect(status.state).toBe("installed");
    if (status.state !== "installed") throw new Error("expected an install");
    expect(status.count).toBe(3);

    for (const slug of SLUGS) {
      for (const variant of REFERENCE_VARIANTS) {
        const text = markdownFor(slug, variant);
        expect(store.read(slug, variant)).toBe(text);
      }
    }

    const manifest = store.manifest();
    expect(manifest).not.toBeNull();
    for (const slug of SLUGS) {
      for (const variant of REFERENCE_VARIANTS) {
        const text = markdownFor(slug, variant);
        const bytes = new TextEncoder().encode(text);
        const saved = manifest?.files[slug]?.[variant];
        expect(saved?.bytes).toBe(bytes.byteLength);
        expect(saved?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
    }

    const expected = [LIBRARY_URL];
    for (const slug of SLUGS) for (const variant of REFERENCE_VARIANTS) expected.push(referenceUrl(slug, variant));
    expect(calls.slice().sort()).toEqual(expected.slice().sort());
    expect(calls.every((url) => url.startsWith(`${REFERENCE_ORIGIN}/`))).toBe(true);
  });

  it("records an HTML body as missing and installs the rest", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    const map = bodies();
    const htmlUrl = referenceUrl("beta", "compact");
    const { fetch } = fakeFetch((url) => {
      if (url === LIBRARY_URL) return new Response(index);
      if (url === htmlUrl) return new Response("<!DOCTYPE html><html><body>login</body></html>");
      return new Response(map.get(url) ?? null, { status: map.has(url) ? 200 : 404 });
    });

    const status = await store.download({ fetch });
    expect(status.state).toBe("installed");
    expect(store.manifest()?.missing).toEqual([{ slug: "beta", variant: "compact", reason: "html" }]);
    expect(store.read("beta", "compact")).toBeNull();
    expect(store.read("beta", "extended")).toBe(markdownFor("beta", "extended"));
    expect(store.read("alpha", "compact")).toBe(markdownFor("alpha", "compact"));
  });

  it("records a body over the per-file limit as missing", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    const map = bodies();
    const bigUrl = referenceUrl("gamma", "extended");
    const big = new Uint8Array(REFERENCE_FILE_MAX + 1).fill(0x61);
    const { fetch } = fakeFetch((url) => {
      if (url === LIBRARY_URL) return new Response(index);
      if (url === bigUrl) return new Response(big);
      return new Response(map.get(url) ?? null, { status: map.has(url) ? 200 : 404 });
    });

    const status = await store.download({ fetch });
    expect(status.state).toBe("installed");
    expect(store.manifest()?.missing).toEqual([{ slug: "gamma", variant: "extended", reason: "archive" }]);
    expect(store.read("gamma", "extended")).toBeNull();
    expect(store.read("gamma", "compact")).toBe(markdownFor("gamma", "compact"));
  });

  it("records a redirect to another host as missing and never calls it", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    const map = bodies();
    const redirectUrl = referenceUrl("alpha", "extended");
    const { fetch, calls } = fakeFetch((url) => {
      if (url === LIBRARY_URL) return new Response(index);
      if (url === redirectUrl) return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
      return new Response(map.get(url) ?? null, { status: map.has(url) ? 200 : 404 });
    });

    const status = await store.download({ fetch });
    expect(status.state).toBe("installed");
    expect(store.manifest()?.missing).toEqual([{ slug: "alpha", variant: "extended", reason: "blocked" }]);
    expect(calls.some((url) => url.includes("evil.example"))).toBe(false);
  });

  it("requests a failing file exactly twice and still installs", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    const map = bodies();
    const failing = referenceUrl("gamma", "extended");
    const { fetch, calls } = fakeFetch((url) => {
      if (url === LIBRARY_URL) return new Response(index);
      if (url === failing) throw new Error("boom");
      return new Response(map.get(url) ?? null, { status: map.has(url) ? 200 : 404 });
    });

    const status = await store.download({ fetch });
    expect(status.state).toBe("installed");
    expect(calls.filter((url) => url === failing)).toHaveLength(2);
    expect(store.manifest()?.missing).toEqual([{ slug: "gamma", variant: "extended", reason: "offline" }]);
  });

  it("records a file that never answers as a timeout, requested once", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    const map = bodies();
    const stuck = referenceUrl("beta", "compact");
    const served = fakeFetch((url, init) => {
      if (url === LIBRARY_URL) return new Response(index);
      if (url === stuck) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        });
      }
      return new Response(map.get(url) ?? null, { status: map.has(url) ? 200 : 404 });
    });
    const status = await store.download({ fetch: served.fetch, fileTimeoutMs: 50 });
    expect(status.state).toBe("installed");
    expect(served.calls.filter((u) => u === stuck)).toHaveLength(1);
    expect(store.manifest()?.missing).toEqual([{ slug: "beta", variant: "compact", reason: "timeout" }]);
  });

  it("keeps the installed set when the index fetch fails", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    const map = bodies();
    await store.download({ fetch: serve(index, map).fetch });

    const before = store.read("alpha", "compact");
    expect(before).toBe(markdownFor("alpha", "compact"));

    const broken = fakeFetch(() => {
      throw new Error("down");
    });
    expect(await codeOf(store.download({ fetch: broken.fetch }))).toBe("offline");
    expect(store.status().state).toBe("installed");
    expect(store.read("alpha", "compact")).toBe(before);
  });

  it("cancels, keeps complete staged files, and resumes", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    const map = bodies();
    const controller = new AbortController();
    let markdown = 0;
    const first = fakeFetch((url) => {
      if (url === LIBRARY_URL) return new Response(index);
      markdown += 1;
      if (markdown === 2) controller.abort();
      return new Response(map.get(url) ?? null, { status: map.has(url) ? 200 : 404 });
    });

    expect(await codeOf(store.download({ fetch: first.fetch, signal: controller.signal }))).toBe("cancelled");
    expect(store.status()).toEqual({ state: "none" });
    expect(partFiles(root)).toEqual([]);

    const second = serve(index, map);
    const status = await store.download({ fetch: second.fetch });
    expect(status.state).toBe("installed");
    expect(second.calls.length).toBeLessThan(6);
    for (const slug of SLUGS) {
      for (const variant of REFERENCE_VARIANTS) expect(store.read(slug, variant)).toBe(markdownFor(slug, variant));
    }
  });

  it("only downloads an entry the index changed", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const map = bodies();
    const firstIndex = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    await store.download({ fetch: serve(firstIndex, map).fetch });

    const updated = JSON.stringify(SLUGS.map((slug) => (slug === "beta" ? entry("beta", { name: "Beta Two" }) : entry(slug))));
    const second = serve(updated, map);
    const status = await store.download({ fetch: second.fetch });
    expect(status.state).toBe("installed");

    const markdownCalls = second.calls.filter((url) => url !== LIBRARY_URL).sort();
    expect(markdownCalls).toEqual([referenceUrl("beta", "compact"), referenceUrl("beta", "extended")].sort());
    expect(store.read("alpha", "compact")).toBe(markdownFor("alpha", "compact"));
    expect(store.read("beta", "compact")).toBe(markdownFor("beta", "compact"));
  });

  it("refuses a file whose bytes no longer match the manifest", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    const map = bodies();
    await store.download({ fetch: serve(index, map).fetch });

    writeFileSync(join(root, "current", "styles", "s-alpha", "compact.md"), "# Tampered\n");
    expect(store.read("alpha", "compact")).toBeNull();
    expect(store.read("alpha", "extended")).toBe(markdownFor("alpha", "extended"));
  });

  it("removes everything", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    const map = bodies();
    await store.download({ fetch: serve(index, map).fetch });
    expect(store.status().state).toBe("installed");

    store.remove();
    expect(store.status()).toEqual({ state: "none" });
  });

  it("fails offline when no Markdown file can be downloaded", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const index = JSON.stringify(SLUGS.map((slug) => entry(slug)));
    const { fetch } = fakeFetch((url) => {
      if (url === LIBRARY_URL) return new Response(index);
      throw new Error("down");
    });

    expect(await codeOf(store.download({ fetch }))).toBe("offline");
    expect(store.status()).toEqual({ state: "none" });
  });
});
