// MCP secrets at rest: header and env values, and (later) OAuth tokens, one
// safeStorage ciphertext per server in mcp-secrets.json. mcp.json keeps only
// the shape and the key names; a vaulted value reads "$vault" there.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SecretBox } from "../settings";

/** What mcp.json holds in place of a value that lives in the vault. */
export const VAULT_MARK = "$vault";

/** Everything secret about one server. */
export interface VaultEntry {
  headers?: Record<string, string>;
  env?: Record<string, string>;
  oauth?: VaultOAuth;
}

/** A remote server's OAuth state: never leaves the main process. */
export interface VaultOAuth {
  /** The secret of a client the user registered themselves (the id is in mcp.json). */
  clientSecret?: string;
  /** What dynamic registration returned (client_id, maybe client_secret, redirect_uris…). */
  client?: Record<string, unknown>;
  /** The token response, plus when it arrived (ms), to know when it expires. */
  tokens?: { access_token: string; token_type: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string; obtained_at: number };
  /** Discovery results (authorization server, its metadata, the resource metadata), so a refresh skips discovery. */
  discovery?: Record<string, unknown>;
  /** Scopes a 403 asked for that the token lacks; the next sign-in asks for these too. */
  stepUpScopes?: string;
}

interface FileShape {
  version: 1;
  /** Keyed by scope and server name ("global:docs", "project:<id>:docs"); base64 ciphertext of a VaultEntry. */
  entries: Record<string, string>;
}

/**
 * A `${VAR}`, `${VAR:-default}` or `${env:VAR}` reference: the value is a
 * template whose secret lives in the environment, so it stays in mcp.json.
 */
const ENV_REF = /\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;

/** Whether a header or env value must go to the vault: anything that isn't empty, a mark or an env reference. */
export function isSecretValue(value: string): boolean {
  return value !== "" && value !== VAULT_MARK && !ENV_REF.test(value);
}

/** Every `${…}` reference in `value` filled from `env`; unknown ones become their default or "". */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => env[name] ?? fallback ?? "");
}

/**
 * The encrypted store. Reads decrypt lazily per entry and are cached; every
 * write is atomic (temp file + rename) and private (0600). A value that no
 * longer decrypts (another machine, a reset keychain) reads as missing, and
 * the server is reported as locked until its secrets are entered again.
 */
export class McpVault {
  private cache = new Map<string, VaultEntry | null>();

  constructor(private file: string, private box: SecretBox) {}

  /** False where the OS can't encrypt (Linux with the plain-text backend): secrets are refused, not stored. */
  get available(): boolean {
    return this.box.available;
  }

  private read(): FileShape {
    if (!existsSync(this.file)) return { version: 1, entries: {} };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<FileShape>;
      return { version: 1, entries: raw.entries && typeof raw.entries === "object" ? raw.entries : {} };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private write(data: FileShape): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Whether an entry exists for this key, whether or not it still decrypts. */
  has(key: string): boolean {
    return key in this.read().entries;
  }

  /** The decrypted entry; null when there is none or it can't be opened here. */
  get(key: string): VaultEntry | null {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const blob = this.read().entries[key];
    let entry: VaultEntry | null = null;
    if (blob && this.box.available) {
      try {
        entry = JSON.parse(this.box.decrypt(blob)) as VaultEntry;
      } catch {
        entry = null;
      }
    }
    this.cache.set(key, entry);
    return entry;
  }

  /** Store an entry (an empty one removes the key). Throws where encryption isn't available. */
  set(key: string, entry: VaultEntry): void {
    const clean = compact(entry);
    if (!clean) return this.remove(key);
    if (!this.box.available) throw new Error("This computer can't encrypt secrets (no OS keychain), so they can't be saved. Use ${VAR} to read the value from an environment variable instead.");
    const data = this.read();
    data.entries[key] = this.box.encrypt(JSON.stringify(clean));
    this.write(data);
    this.cache.set(key, clean);
  }

  /** Replace only the given fields (an empty map or undefined clears that field), keeping the rest. */
  update(key: string, patch: Partial<Record<keyof VaultEntry, unknown>>): void {
    const next: VaultEntry = { ...(this.get(key) ?? {}) };
    for (const [field, value] of Object.entries(patch) as [keyof VaultEntry, unknown][]) {
      if (value === undefined || (typeof value === "object" && value !== null && !Object.keys(value).length)) delete next[field];
      else (next as Record<string, unknown>)[field] = value;
    }
    this.set(key, next);
  }

  /** Move an entry to a new key (a renamed server). */
  rename(from: string, to: string): void {
    if (from === to) return;
    const data = this.read();
    if (!(from in data.entries)) return;
    data.entries[to] = data.entries[from]!;
    delete data.entries[from];
    this.write(data);
    this.cache.delete(from);
    this.cache.delete(to);
  }

  remove(key: string): void {
    const data = this.read();
    this.cache.delete(key);
    if (!(key in data.entries)) return;
    delete data.entries[key];
    this.write(data);
  }

  /** Every key under a prefix, e.g. all of one project's servers. */
  keys(prefix = ""): string[] {
    return Object.keys(this.read().entries).filter((k) => k.startsWith(prefix));
  }

  /** Every decryptable secret value, for redacting logs and events. */
  values(): string[] {
    const out: string[] = [];
    for (const key of this.keys()) {
      const e = this.get(key);
      if (!e) continue;
      out.push(...Object.values(e.headers ?? {}), ...Object.values(e.env ?? {}));
      const o = e.oauth;
      if (o?.clientSecret) out.push(o.clientSecret);
      if (typeof o?.client?.client_secret === "string") out.push(o.client.client_secret);
      if (o?.tokens) out.push(...[o.tokens.access_token, o.tokens.refresh_token, o.tokens.id_token].filter((t): t is string => Boolean(t)));
    }
    return out;
  }
}

function compact(entry: VaultEntry): VaultEntry | null {
  const out: VaultEntry = {};
  if (entry.headers && Object.keys(entry.headers).length) out.headers = entry.headers;
  if (entry.env && Object.keys(entry.env).length) out.env = entry.env;
  if (entry.oauth && Object.keys(entry.oauth).length) out.oauth = entry.oauth;
  return Object.keys(out).length ? out : null;
}
