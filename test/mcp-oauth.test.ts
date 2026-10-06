import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardedFetch, isPrivateAddress, issuerOk, McpAuth, safeAuthorizationUrl } from "../src/main/mcp/oauth";
import { McpVault } from "../src/main/mcp/vault";
import type { SecretBox } from "../src/main/settings";
import type { McpServerSpec } from "../src/shared/types";
import { startMockOAuthServer, type MockOAuthServer } from "./fixtures/mock-oauth-server";
import { tempDir } from "./helpers";

type RemoteSpec = Extract<McpServerSpec, { url: string }>;
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** A stand-in for safeStorage: XOR with a key, so ciphertext never contains the plain text. */
function box(key = 0x5a, available = true): SecretBox {
  return {
    available,
    encrypt: (s) => Buffer.from(Buffer.from(s, "utf-8").map((b) => b ^ key)).toString("base64"),
    decrypt: (b) => {
      const out = Buffer.from(Buffer.from(b, "base64").map((x) => x ^ key)).toString("utf-8");
      // A wrong key gives bytes that aren't the JSON the vault wrote.
      JSON.parse(out);
      return out;
    },
  };
}

const servers: MockOAuthServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

interface Harness {
  server: MockOAuthServer;
  auth: McpAuth;
  vault: McpVault;
  spec: RemoteSpec;
  key: string;
  file: string;
  /** Every authorization URL the fake browser was handed. */
  opened: URL[];
  state: { now: number; openCount: number };
}

/**
 * One fresh mock server + vault + McpAuth. The "browser" parses the
 * authorization URL and fires the redirect at the loopback callback without
 * awaiting the response: that tab only answers after the code is exchanged,
 * which happens after connect() gets control back.
 */
async function harness(options: { boxAvailable?: boolean; iss?: string | null; state?: string } = {}): Promise<Harness> {
  const server = await startMockOAuthServer();
  servers.push(server);
  const file = join(tempDir(), "s.json");
  const vault = new McpVault(file, box(0x5a, options.boxAvailable ?? true));
  const spec: RemoteSpec = { type: "http", url: `${server.base}/mcp`, oauth: { callbackPort: 0 } };
  const opened: URL[] = [];
  const state = { now: Date.now(), openCount: 0 };
  const openExternal = async (url: string): Promise<void> => {
    state.openCount++;
    const authorization = new URL(url);
    opened.push(authorization);
    const redirect = new URL(authorization.searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("code", "c1");
    redirect.searchParams.set("state", options.state ?? authorization.searchParams.get("state") ?? "");
    if (options.iss !== null) redirect.searchParams.set("iss", options.iss ?? server.base);
    void fetch(redirect).then((r) => r.text()).catch(() => undefined);
  };
  const auth = new McpAuth({ vault, openExternal, now: () => state.now, callbackTimeoutMs: 3000 });
  return { server, auth, vault, spec, key: "global:test", file, opened, state };
}

describe("McpAuth sign-in", () => {
  it("signs in, stores the tokens encrypted, and hands them back", async () => {
    const h = await harness();
    const before = Date.now();
    expect(await h.auth.connect(h.key, h.spec)).toEqual({ ok: true });

    const url = h.opened[0]!;
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("resource")).toBe(`${h.server.base}/mcp`);

    const status = h.auth.status(h.key);
    expect(status.signedIn).toBe(true);
    expect(status.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(status.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(await h.auth.accessToken(h.key, h.spec)).toBe("at-1");
    expect(readFileSync(h.file, "utf-8")).not.toContain("at-1");
  });

  it("rejects a state that didn't come from our request and never exchanges the code", async () => {
    const h = await harness({ state: "not-our-state" });
    const result = await h.auth.connect(h.key, h.spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/state|issuer/i);
    expect(h.vault.get(h.key)?.oauth?.tokens).toBeUndefined();
    expect(h.server.requests.some((r) => r.pathname === "/token")).toBe(false);
  });

  it("checks the RFC 9207 issuer against what the server advertised", async () => {
    // A different issuer is rejected.
    const bad = await harness({ iss: "https://evil.example" });
    const wrong = await bad.auth.connect(bad.key, bad.spec);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/state|issuer/i);

    // A missing issuer is rejected while it was advertised…
    const advertised = await harness({ iss: null });
    expect((await advertised.auth.connect(advertised.key, advertised.spec)).ok).toBe(false);

    // …but accepted when the server never claimed to send one.
    const quiet = await harness({ iss: null });
    quiet.server.config.issParameterSupported = false;
    expect(await quiet.auth.connect(quiet.key, quiet.spec)).toEqual({ ok: true });
  });

  it("refuses to start without a keychain, without opening a browser", async () => {
    const h = await harness({ boxAvailable: false });
    const result = await h.auth.connect(h.key, h.spec);
    expect(result.ok).toBe(false);
    expect(h.state.openCount).toBe(0);
  });
});

describe("issuerOk", () => {
  it("matches the RFC 9207 table", () => {
    expect(issuerOk(undefined, false, undefined)).toBe(true);
    expect(issuerOk("iss-1", false, undefined)).toBe(true);
    expect(issuerOk("iss-1", true, "iss-1")).toBe(true);
    expect(issuerOk("iss-1", false, "iss-1")).toBe(true);
    expect(issuerOk("iss-1", true, undefined)).toBe(false);
    expect(issuerOk("iss-1", true, "iss-2")).toBe(false);
    expect(issuerOk(undefined, true, "iss-1")).toBe(false);
    expect(issuerOk(undefined, true, undefined)).toBe(false);
  });
});

describe("safeAuthorizationUrl", () => {
  it("opens only https or loopback http", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "http://example.com/x"]) {
      expect(() => safeAuthorizationUrl(bad)).toThrow();
    }
    expect(safeAuthorizationUrl("https://x.test/a").toString()).toBe("https://x.test/a");
    expect(safeAuthorizationUrl("http://127.0.0.1:5/cb").toString()).toBe("http://127.0.0.1:5/cb");
  });
});

describe("guardedFetch", () => {
  const publicFetch: FetchLike = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

  it("blocks targets that resolve to private, loopback or link-local addresses", async () => {
    for (const address of ["10.0.0.5", "169.254.169.254", "127.0.0.1", "::1", "fc00::1", "::ffff:192.168.1.1"]) {
      const guarded = guardedFetch("https://mcp.example.com/mcp", publicFetch, async () => [address]);
      await expect(guarded("https://auth.example.com/token")).rejects.toThrow(/private/i);
    }
  });

  it("blocks plain http to a host that isn't loopback", async () => {
    const guarded = guardedFetch("https://mcp.example.com/mcp", publicFetch, async () => ["93.184.216.34"]);
    await expect(guarded("http://auth.example.com/token")).rejects.toThrow(/https/i);
  });

  it("checks every redirect hop, not just the first", async () => {
    const seen: string[] = [];
    const redirecting: FetchLike = async (url) => {
      seen.push(String(url));
      return new Response(null, { status: 302, headers: { location: "https://internal.example.com/token" } });
    };
    const resolve = async (host: string) => (host === "internal.example.com" ? ["10.0.0.5"] : ["93.184.216.34"]);
    const guarded = guardedFetch("https://mcp.example.com/mcp", redirecting, resolve);
    await expect(guarded("https://auth.example.com/token")).rejects.toThrow(/private/i);
    expect(seen).toEqual(["https://auth.example.com/token"]);
  });

  it("allows a public destination", async () => {
    const guarded = guardedFetch("https://mcp.example.com/mcp", publicFetch, async () => ["93.184.216.34"]);
    expect((await guarded("https://auth.example.com/token")).status).toBe(200);
  });

  it("treats loopback, link-local, metadata and garbage as private", () => {
    for (const address of ["10.0.0.5", "169.254.169.254", "127.0.0.1", "::1", "fc00::1", "::ffff:192.168.1.1", "not-an-ip", ""]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });
});

describe("McpAuth refresh", () => {
  it("refreshes once past 80% of the lifetime, and only once for concurrent calls", async () => {
    const h = await harness();
    expect(await h.auth.connect(h.key, h.spec)).toEqual({ ok: true });

    // The sign-in itself already exchanged the authorization code once.
    const tokenCalls = () => h.server.requests.filter((r) => r.pathname === "/token");
    const afterSignIn = tokenCalls().length;

    h.state.now = h.vault.get(h.key)!.oauth!.tokens!.obtained_at + 3_600 * 1000 * 0.8 + 1;
    expect(await h.auth.accessToken(h.key, h.spec)).toBe("at-2");
    expect(tokenCalls()).toHaveLength(afterSignIn + 1);
    expect(tokenCalls()[afterSignIn]!.form).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-1" });

    h.state.now = h.vault.get(h.key)!.oauth!.tokens!.obtained_at + 3_600 * 1000 * 0.8 + 1;
    const [a, b] = await Promise.all([h.auth.refresh(h.key, h.spec), h.auth.refresh(h.key, h.spec)]);
    expect([a, b]).toEqual(["at-2", "at-2"]);
    expect(tokenCalls()).toHaveLength(afterSignIn + 2);
  });

  it("clears the session when the refresh is rejected", async () => {
    const h = await harness();
    expect(await h.auth.connect(h.key, h.spec)).toEqual({ ok: true });
    h.server.config.refreshFails = true;
    h.state.now = h.vault.get(h.key)!.oauth!.tokens!.obtained_at + 3_600 * 1000 * 0.8 + 1;
    expect(await h.auth.refresh(h.key, h.spec)).toBeNull();
    expect(h.auth.status(h.key).signedIn).toBe(false);
  });
});

describe("McpAuth scope step-up and sign-out", () => {
  it("carries a step-up scope into the next authorization request", async () => {
    const h = await harness();
    expect(await h.auth.connect(h.key, h.spec)).toEqual({ ok: true });
    h.auth.noteStepUp(h.key, "write");
    expect(h.auth.status(h.key).needsScopes).toBe("write");

    expect(await h.auth.connect(h.key, h.spec)).toEqual({ ok: true });
    const scope = h.opened.at(-1)!.searchParams.get("scope") ?? "";
    expect(scope.split(/\s+/)).toContain("write");
  });

  it("revokes both tokens and keeps the user's own client secret", async () => {
    const h = await harness();
    expect(await h.auth.connect(h.key, h.spec)).toEqual({ ok: true });
    h.auth.setClientSecret(h.key, "cs-1");

    await h.auth.disconnect(h.key, h.spec);

    const revokes = h.server.requests.filter((r) => r.pathname === "/revoke");
    expect(revokes.map((r) => r.form.token).sort()).toEqual(["at-1", "rt-1"]);
    for (const r of revokes) expect(r.form.client_id).toBe("client-1");
    expect(h.auth.status(h.key).signedIn).toBe(false);
    expect(h.vault.get(h.key)?.oauth?.clientSecret).toBe("cs-1");
  });
});
