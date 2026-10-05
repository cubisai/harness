// Sign-in for remote MCP servers, the way Claude Code does it: discover the
// server's authorization server (RFC 9728 → RFC 8414 / OIDC), register a client
// (the user's own, else dynamically), open the browser with PKCE, a state and
// the RFC 8707 resource, take the code on a loopback callback, check the RFC
// 9207 issuer, and keep the tokens in the vault. Tokens never leave the main
// process: the gateway adds them to each upstream request.

import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer, type Server } from "node:http";
import { BlockList, isIP } from "node:net";
import { auth, refreshAuthorization, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerSpec } from "../../shared/types";
import type { McpVault, VaultOAuth } from "./vault";

type RemoteSpec = Extract<McpServerSpec, { url: string }>;
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** The loopback port the sign-in callback listens on unless a server sets its own; stable, so a registered redirect URI stays valid. */
export const DEFAULT_CALLBACK_PORT = 33418;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** Refresh once this share of a token's lifetime has passed. */
const REFRESH_AT = 0.8;

export interface McpAuthStatus {
  signedIn: boolean;
  /** Epoch ms, when the token says. */
  expiresAt?: number;
  scopes?: string;
  /** Scopes a 403 asked for: sign in again to grant them. */
  needsScopes?: string;
}

// ---- URL safety ----

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase()) || host.startsWith("127.");
}

/** Only https, or http to this machine, may be opened in the browser (never javascript:, data:, file: …). */
export function safeAuthorizationUrl(raw: string | URL): URL {
  const url = new URL(String(raw));
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new Error(`Refusing to open a sign-in page at a ${url.protocol} URL.`);
}

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::1", 128],
  ["::", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv6");

/** Whether an IP address is private, loopback, link-local (cloud metadata) or otherwise not on the public internet. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1]! : address;
  const family = isIP(ip);
  if (!family) return true;
  return PRIVATE.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/**
 * fetch for OAuth discovery, registration and token calls, guarded against a
 * malicious server pointing them inward (SSRF): https only (http only to this
 * machine), no private, loopback or link-local addresses unless the MCP server
 * itself lives on one (the user's own local server), and every redirect hop
 * checked the same way.
 */
export function guardedFetch(serverUrl: string, base: FetchLike = fetch, resolve: (host: string) => Promise<string[]> = defaultResolve): FetchLike {
  const server = new URL(serverUrl);
  const serverIsLocal = isLoopbackHost(server.hostname) || (isIP(server.hostname.replace(/^\[|\]$/g, "")) !== 0 && isPrivateAddress(server.hostname.replace(/^\[|\]$/g, "")));
  const check = async (target: URL) => {
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (target.protocol !== "https:" && !(target.protocol === "http:" && isLoopbackHost(host) && serverIsLocal)) throw new Error(`Blocked an OAuth request to ${target.protocol}//${target.host}: only https is allowed.`);
    if (serverIsLocal) return;
    const addresses = isIP(host) ? [host] : await resolve(host);
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error(`Blocked an OAuth request to ${target.host}: it resolves to a private address.`);
  };
  return async (input, init) => {
    let url = new URL(String(input));
    let current = init;
    for (let hop = 0; hop < 5; hop++) {
      await check(url);
      const res = await base(url, { ...current, redirect: "manual" });
      if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) return res;
      url = new URL(res.headers.get("location")!, url);
      // A redirect turns the request into a plain GET, as browsers do for 301/302/303.
      if (res.status !== 307 && res.status !== 308) current = { ...current, method: "GET", body: undefined };
    }
    throw new Error("Too many redirects during sign-in.");
  };
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

// ---- the callback ----

interface CallbackResult {
  code?: string;
  state?: string;
  iss?: string;
  error?: string;
  errorDescription?: string;
}

interface Callback {
  url: string;
  result: Promise<CallbackResult>;
  /** Answer the waiting browser tab, then stop listening. */
  finish(ok: boolean, message: string): void;
}

async function listen(port: number): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : port };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(ok: boolean, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>CubiQ</title><style>body{font:15px -apple-system,"Segoe UI",system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#F7F8FA;color:#0B0D10}main{max-width:420px;padding:24px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#5B606B}</style><main><h1>${ok ? "Connected" : "Sign-in didn't finish"}</h1><p>${escapeHtml(message)}</p></main>`;
}

/** Listen on the loopback port for the browser's redirect; a busy default port falls back to any free one. */
async function startCallback(port: number, fixed: boolean): Promise<Callback> {
  let bound: { server: Server; port: number };
  try {
    bound = await listen(port);
  } catch (err) {
    if (fixed) throw new Error(`Port ${port} for the sign-in callback is busy (${err instanceof Error ? err.message : String(err)}).`);
    bound = await listen(0);
  }
  const { server } = bound;
  let respond: ((ok: boolean, message: string) => void) | null = null;
  const result = new Promise<CallbackResult>((resolve) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const q = url.searchParams;
      // The tab waits here until the code is exchanged, so it can say whether that worked.
      respond = (ok, message) => {
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(ok, message));
      };
      resolve({
        code: q.get("code") ?? undefined,
        state: q.get("state") ?? undefined,
        iss: q.get("iss") ?? undefined,
        error: q.get("error") ?? undefined,
        errorDescription: q.get("error_description") ?? undefined,
      });
    });
  });
  return {
    url: `http://127.0.0.1:${bound.port}/callback`,
    result,
    finish(ok, message) {
      respond?.(ok, message);
      respond = null;
      server.close();
      server.closeAllConnections?.();
    },
  };
}

/**
 * RFC 9207 issuer check, per the MCP authorization spec's table: a present
 * `iss` must equal the issuer recorded before the redirect (exact string
 * compare, no normalization); an absent one is rejected only when the server
 * advertised that it sends it.
 */
export function issuerOk(recorded: string | undefined, advertised: boolean, iss: string | undefined): boolean {
  if (iss !== undefined) return recorded !== undefined && iss === recorded;
  return !advertised;
}

// ---- the provider ----

/** The SDK's provider interface, backed by the vault for one server. */
class VaultProvider implements OAuthClientProvider {
  verifier: string | null = null;
  expectedState: string | null = null;
  issuer: { recorded?: string; advertised: boolean } = { advertised: false };
  /** While signing in, act as if there were no tokens, so the SDK starts a fresh authorization instead of refreshing. */
  fresh = false;

  constructor(
    private vault: McpVault,
    private key: string,
    private spec: RemoteSpec,
    private redirect: string,
    private open: (url: string) => Promise<void>,
  ) {}

  private oauth(): VaultOAuth {
    return this.vault.get(this.key)?.oauth ?? {};
  }

  private save(patch: Partial<VaultOAuth>): void {
    const next: VaultOAuth = { ...this.oauth(), ...patch };
    for (const k of Object.keys(next) as (keyof VaultOAuth)[]) if (next[k] === undefined) delete next[k];
    this.vault.update(this.key, { oauth: next });
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "CubiQ",
      client_uri: "https://github.com/cubisai/harness",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.expectedState = randomBytes(32).toString("base64url");
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const own = this.spec.oauth?.clientId;
    if (own) {
      const secret = this.oauth().clientSecret;
      return { client_id: own, ...(secret && { client_secret: secret }) };
    }
    const saved = this.oauth().client as (OAuthClientInformationMixed & { redirect_uris?: string[] }) | undefined;
    // A client registered for another callback port can't receive this redirect: register again.
    if (saved && Array.isArray(saved.redirect_uris) && !saved.redirect_uris.includes(this.redirect)) return undefined;
    return saved;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.save({ client: { ...info } as Record<string, unknown> });
  }

  tokens(): OAuthTokens | undefined {
    if (this.fresh) return undefined;
    const t = this.oauth().tokens;
    if (!t) return undefined;
    const { obtained_at: _o, ...tokens } = t;
    return tokens as OAuthTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const previous = this.oauth().tokens;
    this.save({
      tokens: {
        access_token: tokens.access_token,
        token_type: tokens.token_type,
        // A refresh answer may leave the refresh token out: keep the old one.
        ...((tokens.refresh_token ?? previous?.refresh_token) && { refresh_token: tokens.refresh_token ?? previous?.refresh_token }),
        ...(tokens.expires_in !== undefined && { expires_in: tokens.expires_in }),
        ...(tokens.scope && { scope: tokens.scope }),
        obtained_at: Date.now(),
      },
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const url = safeAuthorizationUrl(authorizationUrl);
    // Record the issuer to expect back before the browser leaves (RFC 9207).
    const meta = (this.oauth().discovery as OAuthDiscoveryState | undefined)?.authorizationServerMetadata as { issuer?: string; authorization_response_iss_parameter_supported?: boolean } | undefined;
    this.issuer = { recorded: meta?.issuer, advertised: meta?.authorization_response_iss_parameter_supported === true };
    await this.open(url.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("No sign-in is in progress.");
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.save({ discovery: JSON.parse(JSON.stringify(state)) as Record<string, unknown> });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.oauth().discovery as OAuthDiscoveryState | undefined;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "verifier" || scope === "all") this.verifier = null;
    if (scope === "all") return this.save({ client: undefined, tokens: undefined, discovery: undefined });
    if (scope === "client") this.save({ client: undefined });
    if (scope === "tokens") this.save({ tokens: undefined });
    if (scope === "discovery") this.save({ discovery: undefined });
  }
}

// ---- the public face ----

export interface McpAuthDeps {
  vault: McpVault;
  /** Open a URL in the user's browser (shell.openExternal); never a shell command. */
  openExternal: (url: string) => Promise<void>;
  fetchFn?: FetchLike;
  resolve?: (host: string) => Promise<string[]>;
  now?: () => number;
  callbackTimeoutMs?: number;
}

/** Sign-in, tokens, refresh and sign-out for the remote servers, keyed like the vault ("global:name"). */
export class McpAuth {
  private refreshing = new Map<string, Promise<string | null>>();
  private signingIn = new Map<string, Promise<{ ok: true } | { ok: false; error: string }>>();

  constructor(private deps: McpAuthDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private fetchFor(spec: RemoteSpec): FetchLike {
    return guardedFetch(spec.url, this.deps.fetchFn ?? fetch, this.deps.resolve);
  }

  private oauth(key: string): VaultOAuth {
    return this.deps.vault.get(key)?.oauth ?? {};
  }

  status(key: string): McpAuthStatus {
    const o = this.oauth(key);
    const t = o.tokens;
    return {
      signedIn: Boolean(t?.access_token),
      ...(t?.expires_in !== undefined && { expiresAt: t.obtained_at + t.expires_in * 1000 }),
      ...(t?.scope && { scopes: t.scope }),
      ...(o.stepUpScopes && { needsScopes: o.stepUpScopes }),
    };
  }

  /** Whether the server has a token or a client of ours, i.e. whether the gateway should send a bearer. */
  hasTokens(key: string): boolean {
    return Boolean(this.oauth(key).tokens?.access_token);
  }

  /** Interactive sign-in: opens the browser and waits (up to 5 minutes) for the redirect. One at a time per server. */
  connect(key: string, spec: RemoteSpec): Promise<{ ok: true } | { ok: false; error: string }> {
    const running = this.signingIn.get(key);
    if (running) return running;
    const run = this.signIn(key, spec).finally(() => this.signingIn.delete(key));
    this.signingIn.set(key, run);
    return run;
  }

  private async signIn(key: string, spec: RemoteSpec): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.deps.vault.available) return { ok: false, error: "This computer can't encrypt secrets (no OS keychain), so a sign-in can't be kept." };
    const fixed = spec.oauth?.callbackPort !== undefined;
    let callback: Callback;
    try {
      callback = await startCallback(spec.oauth?.callbackPort ?? DEFAULT_CALLBACK_PORT, fixed);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const provider = new VaultProvider(this.deps.vault, key, spec, callback.url, this.deps.openExternal);
    provider.fresh = true;
    const fetchFn = this.fetchFor(spec);
    const o = this.oauth(key);
    // Ask for what the user set, plus anything a 403 said was missing (step-up keeps earlier grants: scopes are unioned).
    const scope = union(spec.oauth?.scopes, o.tokens?.scope && o.stepUpScopes ? o.tokens.scope : undefined, o.stepUpScopes);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Rediscover each time: the URL or the server's setup may have changed since the last sign-in.
      provider.invalidateCredentials("discovery");
      const first = await auth(provider, { serverUrl: spec.url, ...(scope && { scope }), fetchFn });
      if (first === "AUTHORIZED") return { ok: true };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Sign-in timed out after 5 minutes.")), this.deps.callbackTimeoutMs ?? SIGN_IN_TIMEOUT_MS);
      });
      const answer = await Promise.race([callback.result, timeout]);
      const issuerMatches = issuerOk(provider.issuer.recorded, provider.issuer.advertised, answer.iss);
      // The state proves this redirect answers our request; single use.
      const stateMatches = Boolean(answer.state) && answer.state === provider.expectedState;
      provider.expectedState = null;
      if (!stateMatches || !issuerMatches) {
        callback.finish(false, "The answer didn't match this sign-in, so it was ignored. Try again from CubiQ.");
        return { ok: false, error: "The sign-in answer didn't match the request (state or issuer), so it was rejected." };
      }
      if (answer.error || !answer.code) {
        const why = (answer.errorDescription ?? answer.error ?? "no code").slice(0, 200);
        callback.finish(false, `The server said: ${why}`);
        return { ok: false, error: answer.error === "access_denied" ? "Sign-in was cancelled." : `The server refused the sign-in: ${why}` };
      }
      provider.fresh = false;
      await auth(provider, { serverUrl: spec.url, authorizationCode: answer.code, fetchFn });
      this.deps.vault.update(key, { oauth: { ...this.oauth(key), stepUpScopes: undefined } });
      callback.finish(true, "You can close this tab and go back to CubiQ.");
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      callback.finish(false, "Something went wrong. Go back to CubiQ for details.");
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
      provider.verifier = null;
      callback.finish(false, "Sign-in ended.");
    }
  }

  /** A usable access token, refreshed first when most of its life is gone; null = sign in. Never opens the browser. */
  async accessToken(key: string, spec: RemoteSpec): Promise<string | null> {
    const t = this.oauth(key).tokens;
    if (!t) return null;
    const stale = t.expires_in !== undefined && this.now() >= t.obtained_at + t.expires_in * 1000 * REFRESH_AT;
    if (!stale) return t.access_token;
    return (await this.refresh(key, spec)) ?? (this.now() < t.obtained_at + (t.expires_in ?? 0) * 1000 ? t.access_token : null);
  }

  /** Refresh now (the server said 401). One refresh per server at a time; null when there's no way to. */
  refresh(key: string, spec: RemoteSpec): Promise<string | null> {
    const running = this.refreshing.get(key);
    if (running) return running;
    const run = this.doRefresh(key, spec).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, run);
    return run;
  }

  private async doRefresh(key: string, spec: RemoteSpec): Promise<string | null> {
    const o = this.oauth(key);
    const refreshToken = o.tokens?.refresh_token;
    const discovery = o.discovery as OAuthDiscoveryState | undefined;
    if (!refreshToken || !discovery?.authorizationServerUrl) return null;
    const provider = new VaultProvider(this.deps.vault, key, spec, "http://127.0.0.1/callback", this.deps.openExternal);
    const clientInformation = provider.clientInformation() ?? (o.client as OAuthClientInformationMixed | undefined);
    if (!clientInformation) return null;
    try {
      const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation,
        refreshToken,
        ...(discovery.resourceMetadata?.resource && { resource: new URL(discovery.resourceMetadata.resource) }),
        fetchFn: this.fetchFor(spec),
      });
      provider.saveTokens(tokens);
      return tokens.access_token;
    } catch {
      // invalid_grant and friends: the refresh token is dead; the user has to sign in again.
      this.deps.vault.update(key, { oauth: { ...o, tokens: undefined } });
      return null;
    }
  }

  /** A 403 asked for more scopes: remember them for the next sign-in. */
  noteStepUp(key: string, scopes: string): void {
    const o = this.oauth(key);
    this.deps.vault.update(key, { oauth: { ...o, stepUpScopes: union(o.stepUpScopes, scopes) } });
  }

  /** Sign out: revoke at the server when it offers that (best effort), then forget tokens and the registered client. */
  async disconnect(key: string, spec: RemoteSpec): Promise<void> {
    const o = this.oauth(key);
    const discovery = o.discovery as OAuthDiscoveryState | undefined;
    const endpoint = (discovery?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
    const client = (spec.oauth?.clientId ? { client_id: spec.oauth.clientId, client_secret: o.clientSecret } : o.client) as { client_id?: string; client_secret?: string } | undefined;
    if (endpoint && client?.client_id) {
      const fetchFn = this.fetchFor(spec);
      for (const token of [o.tokens?.refresh_token, o.tokens?.access_token].filter((t): t is string => Boolean(t))) {
        const body = new URLSearchParams({ token, client_id: client.client_id, ...(client.client_secret && { client_secret: client.client_secret }) });
        await fetchFn(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(5000) }).catch(() => {});
      }
    }
    // The user's own client secret stays (it's configuration); everything the sign-in produced goes.
    this.deps.vault.update(key, { oauth: o.clientSecret ? { clientSecret: o.clientSecret } : undefined });
  }

  /** Store or clear the secret of a client the user registered themselves. */
  setClientSecret(key: string, secret: string | null): void {
    const o = this.oauth(key);
    this.deps.vault.update(key, { oauth: { ...o, clientSecret: secret || undefined } });
  }
}

/** Space-separated scope lists merged, without duplicates; undefined when empty. */
function union(...lists: (string | undefined)[]): string | undefined {
  const all = new Set(lists.flatMap((l) => (l ?? "").split(/\s+/)).filter(Boolean));
  return all.size ? [...all].join(" ") : undefined;
}
