import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CredentialChoice,
  PermissionMode,
  Provider,
  ProviderInput,
  ProviderSecret,
  ProviderView,
  SecretName,
  Settings,
  SettingsView,
} from "../shared/types";
import { LEGACY_ENV, LEGACY_PROVIDERS, isProviderId, legacyEnv as legacyEnvFor, type LegacyProviderId } from "./providers";
import { protocolKeyVar } from "./inject/keys";

/** Encrypts secrets at rest. In the app this is Electron's safeStorage (the OS keychain). */
export interface SecretBox {
  available: boolean;
  encrypt(plain: string): string; // base64
  decrypt(b64: string): string;
}

const DEFAULTS: Settings = { theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, providerInjection: {} };

interface FileShape {
  schemaVersion?: number; // absent = the legacy v1 shape
  settings?: Partial<Settings>;
  providers?: Provider[];
  migratedProviders?: string[];
  credentials?: Record<string, CredentialChoice>; // keyed by agent id
  secrets?: Partial<Record<SecretName, string>>; // encrypted, base64 — legacy v1, never modified
}

/**
 * The app's settings, in one JSON file in its data folder. API keys are
 * stored encrypted and never leave the main process: the renderer only
 * learns whether each one is set.
 */
export class SettingsStore {
  private data: FileShape;

  constructor(
    private file: string,
    private box: SecretBox,
  ) {
    this.data = this.read();
    this.migrate();
    this.migrateDeepseekDefault();
  }

  private read(): FileShape {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf-8")) as FileShape;
    } catch {
      return {}; // a corrupt file resets to defaults rather than blocking startup
    }
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /**
   * One-shot v1 → v2 migration: a stored legacy key becomes a provider whose
   * secret is the same ciphertext, byte for byte. `secrets.*` is left intact so
   * downgrading still finds the keys; `schemaVersion` gates a re-run.
   */
  private migrate(): void {
    if ((this.data.schemaVersion ?? 1) >= 2) return;
    const existed = existsSync(this.file);
    const secrets = this.data.secrets ?? {};
    const migrated: string[] = [];
    for (const id of Object.keys(LEGACY_ENV) as LegacyProviderId[]) {
      const blob = secrets[id];
      if (!blob || this.data.providers?.some((p) => p.id === id)) continue;
      (this.data.providers ??= []).push({ id, ...LEGACY_PROVIDERS[id], secret: { kind: "safeStorage", ciphertext: blob } });
      migrated.push(id);
    }
    this.data.migratedProviders = migrated;
    // A saved anthropic key already overrides Claude's subscription through process.env,
    // so the upgrade must keep Claude on BYOK for it.
    if (secrets.anthropic && this.data.credentials?.claude === undefined) {
      (this.data.credentials ??= {}).claude = { kind: "byok", providerId: "anthropic" };
    }
    this.data.schemaVersion = 2;
    // Write only when a key actually moved: a brand-new install, a keyless file, or a corrupt
    // file (read() fell back to {}) must not be rewritten at startup; the next update() persists v2.
    if (existed && migrated.length > 0) this.write();
  }

  /**
   * One-shot v2 → v3 migration: until now every saved key reached every agent
   * through the global env, so dsh had its DeepSeek key. Keep that behaviour
   * once the global export goes: a stored DeepSeek provider with no explicit
   * choice for dsh becomes that provider's BYOK. Runs after `migrate()`, so a
   * v1 file falls through both steps in one construction. `schemaVersion` gates
   * a re-run, and the file is written only when a credential actually changed.
   */
  private migrateDeepseekDefault(): void {
    if ((this.data.schemaVersion ?? 1) >= 3) return;
    const existed = existsSync(this.file);
    let added = false;
    if (this.findProvider("deepseek") && this.data.credentials?.deepseek === undefined) {
      (this.data.credentials ??= {}).deepseek = { kind: "byok", providerId: "deepseek" };
      added = true;
    }
    this.data.schemaVersion = 3;
    if (existed && added) this.write();
  }

  get(): Settings {
    return { ...DEFAULTS, ...this.data.settings };
  }

  view(): SettingsView {
    return {
      ...this.get(),
      providers: this.providers().map((p) => this.providerView(p)),
      providerCredential: { ...(this.data.credentials ?? {}) },
      migratedProviders: [...(this.data.migratedProviders ?? [])],
      secretsEncrypted: this.box.available,
    };
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.get() };
    if (patch.theme && ["system", "light", "dark"].includes(patch.theme)) next.theme = patch.theme;
    if (patch.defaultAgent !== undefined) next.defaultAgent = patch.defaultAgent;
    if (patch.defaultPermissionMode && (["ask", "auto-edit", "full"] as PermissionMode[]).includes(patch.defaultPermissionMode)) {
      next.defaultPermissionMode = patch.defaultPermissionMode;
    }
    if (typeof patch.autoUpdate === "boolean") next.autoUpdate = patch.autoUpdate;
    if (patch.editor !== undefined) next.editor = typeof patch.editor === "string" ? patch.editor : null;
    if (patch.providerInjection && typeof patch.providerInjection === "object" && !Array.isArray(patch.providerInjection)) {
      // Only agent ids mapped to booleans; the renderer chooses the keys, so
      // anything else in the object is dropped rather than persisted.
      const injection: Record<string, boolean> = {};
      for (const [agentId, on] of Object.entries(patch.providerInjection)) if (typeof on === "boolean") injection[agentId] = on;
      next.providerInjection = injection;
    }
    this.data.settings = next;
    this.write();
    return next;
  }

  private findProvider(id: string): Provider | undefined {
    return this.data.providers?.find((p) => p.id === id);
  }

  providers(): Provider[] {
    return [...(this.data.providers ?? [])];
  }

  /** A Provider as the renderer sees it: the secret itself is replaced by its kind and whether it is set. */
  providerView(p: Provider): ProviderView {
    const { secret, ...rest } = p;
    const hasSecret =
      secret.kind === "safeStorage"
        ? Boolean(secret.ciphertext)
        : secret.kind === "envRef"
          ? Boolean(secret.envVar)
          : Boolean(secret.command?.length);
    return { ...rest, secretKind: secret.kind, hasSecret };
  }

  /**
   * Create or replace a provider. A duplicate id replaces every field including
   * wireProtocol, but keeps the stored ciphertext unless secretValue is given:
   * a string stores a new encrypted key, null clears it.
   */
  saveProvider(input: ProviderInput, secretValue?: string | null): ProviderView {
    if (!isProviderId(input.id)) throw new Error(`invalid provider id ${input.id}`);
    // A command secret runs a program; the renderer must never be able to choose one.
    if (input.secret?.kind === "command") throw new Error("command secrets can't be set from the app");
    const existing = this.findProvider(input.id);
    let secret: ProviderSecret;
    if (typeof secretValue === "string") {
      secret = { kind: "safeStorage", ciphertext: this.box.encrypt(secretValue.trim()) };
    } else {
      secret = { ...(input.secret ?? { kind: existing?.secret.kind ?? "safeStorage" }) };
      const ciphertext = secretValue === null ? undefined : existing?.secret.ciphertext;
      if (ciphertext !== undefined) secret.ciphertext = ciphertext;
    }
    const provider: Provider = { ...input, secret };
    const providers = this.data.providers ?? (this.data.providers = []);
    const at = providers.findIndex((p) => p.id === input.id);
    if (at >= 0) providers[at] = provider;
    else providers.push(provider);
    this.write();
    return this.providerView(provider);
  }

  /** Remove a provider and point any credential at it back to subscription. `secrets.*` is untouched. */
  removeProvider(id: string): void {
    this.data.providers = (this.data.providers ?? []).filter((p) => p.id !== id);
    const credentials = this.data.credentials;
    if (credentials) {
      for (const [agent, choice] of Object.entries(credentials)) {
        if (choice.kind === "byok" && choice.providerId === id) credentials[agent] = { kind: "subscription" };
      }
    }
    this.write();
  }

  setProviderSecret(id: string, value: string | null): void {
    const provider = this.findProvider(id);
    if (!provider) throw new Error(`unknown provider ${id}`);
    const trimmed = value?.trim();
    if (trimmed) provider.secret = { kind: "safeStorage", ciphertext: this.box.encrypt(trimmed) };
    else delete provider.secret.ciphertext;
    this.write();
  }

  /** The provider's plaintext key, or null. envRef reads our own env without touching the box. */
  providerSecret(id: string): string | null {
    const secret = this.findProvider(id)?.secret;
    if (!secret) return null;
    if (secret.kind === "envRef") return secret.envVar ? process.env[secret.envVar] ?? null : null;
    if (secret.kind === "command") return null; // command secrets are Phase 2
    if (!secret.ciphertext) return null;
    try {
      return this.box.decrypt(secret.ciphertext);
    } catch {
      return null; // encrypted on another machine or user account
    }
  }

  /** The provider's own env map plus its resolved key under the variable its protocol expects. */
  providerEnv(id: string): Record<string, string> {
    const provider = this.findProvider(id);
    if (!provider) return {};
    const out: Record<string, string> = { ...provider.env };
    const envVar = protocolKeyVar(provider);
    const value = this.providerSecret(id);
    if (envVar !== null && value !== null) out[envVar] = value;
    return out;
  }

  /** Stored legacy keys as environment variables, sourced from their migrated providers. */
  legacyEnv(): Record<string, string> {
    return legacyEnvFor((id) => (this.findProvider(id) ? this.providerSecret(id) : null));
  }

  /** Every env var name a provider key may occupy, so editors don't inherit one. */
  secretEnvNames(): string[] {
    const names = new Set<string>(Object.values(LEGACY_ENV));
    for (const provider of this.providers()) for (const name of Object.keys(this.providerEnv(provider.id))) names.add(name);
    return [...names];
  }

  credential(agentId: string): CredentialChoice {
    return this.data.credentials?.[agentId] ?? { kind: "subscription" };
  }

  setCredential(agentId: string, choice: CredentialChoice): void {
    if (choice.kind === "byok" && !this.findProvider(choice.providerId)) throw new Error(`unknown provider ${choice.providerId}`);
    (this.data.credentials ??= {})[agentId] = choice;
    this.write();
  }
}
