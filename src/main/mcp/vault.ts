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
    }
    return out;
  }
}

function compact(entry: VaultEntry): VaultEntry | null {
  const out: VaultEntry = {};
  if (entry.headers && Object.keys(entry.headers).length) out.headers = entry.headers;
  if (entry.env && Object.keys(entry.env).length) out.env = entry.env;
  return Object.keys(out).length ? out : null;
}
