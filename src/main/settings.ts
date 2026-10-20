import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CredentialChoice,
  PermissionMode,
  Provider,
  ProviderInput,
  ProviderSecret,
  ProviderView,
  SecretName,
  PaneLayout,
  Settings,
  SettingsView,
} from "../shared/types";
import { DEFAULT_LAYOUT, sanitizeLayout } from "../shared/layout";
import { isZoom } from "../shared/zoom";
import { LEARN_DEFAULTS, type LearnSettings } from "../shared/learn";
import { LEGACY_ENV, LEGACY_PROVIDERS, isProviderId, type LegacyProviderId } from "./providers";
import { headerPlan, resolvedHeaders } from "./inject/headers";
import { protocolKeyVar } from "./inject/keys";
import { ANTIGRAVITY_ACK_VERSION } from "../shared/provider-rules";

function ackIsCurrent(ack: Settings["antigravityAck"]): boolean {
  return ack?.version === ANTIGRAVITY_ACK_VERSION && typeof ack.at === "number";
}

/** Encrypts secrets at rest. In the app this is Electron's safeStorage (the OS keychain). */
export interface SecretBox {
  available: boolean;
  encrypt(plain: string): string; // base64
  decrypt(b64: string): string;
}

const DEFAULTS: Settings = { theme: "system", motion: "full", density: "comfortable", zoom: 1, antigravity: false, antigravityAck: null, defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null, paneLayout: { ...DEFAULT_LAYOUT }, memory: { enabled: true, disabledProjects: [] } };

/** A settings export file. */
export interface SettingsExport {
  kind: "unskilled-settings";
  version: 1;
  exportedAt: number;
  settings: Omit<Settings, "antigravity" | "antigravityAck">;
  providers: Provider[];
  credentials: Record<string, CredentialChoice>;
}

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
      // A corrupt file resets to defaults rather than blocking startup; keep a
      // copy first, since the next write would otherwise lose its secrets.* for good.
      try {
        copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // unreadable too: nothing to keep
      }
      return {};
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
   * through the global env, so the DeepSeek ACP agent (since removed) had its
   * DeepSeek key. Keep that behaviour once the global export goes: a stored
   * DeepSeek provider with no explicit choice for that agent id becomes that
   * provider's BYOK. Runs after `migrate()`, so a
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

  get(): Settings & { paneLayout: PaneLayout } {
    const stored = this.data.settings;
    return { ...DEFAULTS, ...stored, paneLayout: sanitizeLayout({ ...DEFAULT_LAYOUT, ...stored?.paneLayout }), memory: { ...DEFAULTS.memory!, ...stored?.memory }, learn: sanitizeLearn(stored?.learn) };
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
    if (patch.motion && ["instant", "subtle", "full"].includes(patch.motion)) next.motion = patch.motion;
    if (patch.density && ["comfortable", "compact"].includes(patch.density)) next.density = patch.density;
    if (isZoom(patch.zoom)) next.zoom = patch.zoom;
    if (patch.defaultAgent !== undefined) next.defaultAgent = patch.defaultAgent;
    if (patch.defaultPermissionMode && (["ask", "auto-edit", "plan", "full"] as PermissionMode[]).includes(patch.defaultPermissionMode)) {
      next.defaultPermissionMode = patch.defaultPermissionMode;
    }
    if (typeof patch.autoUpdate === "boolean") next.autoUpdate = patch.autoUpdate;
    if (patch.agentBinary && typeof patch.agentBinary === "object" && !Array.isArray(patch.agentBinary)) {
      const pins: Record<string, string> = {};
      for (const [agent, path] of Object.entries(patch.agentBinary)) if (typeof path === "string" && path) pins[agent] = path;
      next.agentBinary = pins;
    }
    if (patch.editor !== undefined) next.editor = typeof patch.editor === "string" ? patch.editor : null;
    if (patch.paneLayout !== undefined) next.paneLayout = sanitizeLayout(patch.paneLayout);
    if (patch.skills && typeof patch.skills === "object" && Array.isArray(patch.skills.disabled)) {
      // Only `${origin}:${name}` strings; a wild renderer payload can't grow this unbounded.
      next.skills = { disabled: patch.skills.disabled.filter((s): s is string => typeof s === "string").slice(0, 500) };
    }
    if (patch.memory && typeof patch.memory === "object" && !Array.isArray(patch.memory)) {
      const current = next.memory ?? { enabled: true, disabledProjects: [] };
      const enabled = typeof patch.memory.enabled === "boolean" ? patch.memory.enabled : current.enabled;
      const list = Array.isArray(patch.memory.disabledProjects) ? patch.memory.disabledProjects : current.disabledProjects;
      const disabledProjects = [...new Set(list.filter((s): s is string => typeof s === "string"))].slice(0, 500);
      next.memory = { enabled, disabledProjects };
    }
    if (patch.learn && typeof patch.learn === "object" && !Array.isArray(patch.learn)) next.learn = sanitizeLearn({ ...next.learn, ...patch.learn });
    if (patch.mcpRouter === "auto" || patch.mcpRouter === "off") next.mcpRouter = patch.mcpRouter;
    if (patch.codeMode === "off" || patch.codeMode === "on") next.codeMode = patch.codeMode;
    if (typeof patch.sidebarGroupByProject === "boolean") next.sidebarGroupByProject = patch.sidebarGroupByProject;
    if (typeof patch.uiBlocks === "boolean") next.uiBlocks = patch.uiBlocks;
    if (typeof patch.linkPreviews === "boolean") next.linkPreviews = patch.linkPreviews;
    if (patch.splash && ["agent", "voyage", "off"].includes(patch.splash)) next.splash = patch.splash;
    // The Antigravity opt-in: the acknowledgement is stamped here, never trusted from
    // the caller, and the flag turns on only with a current one.
    if (patch.antigravityAck === null) next.antigravityAck = null;
    else if (patch.antigravityAck?.version === ANTIGRAVITY_ACK_VERSION) next.antigravityAck = { version: ANTIGRAVITY_ACK_VERSION, at: Date.now() };
    if (patch.antigravity === false || !ackIsCurrent(next.antigravityAck)) next.antigravity = false;
    else if (patch.antigravity === true) next.antigravity = true;
    this.data.settings = next;
    this.write();
    return next;
  }

  /** Antigravity is on: the flag and an acknowledgement of the current disclosure. */
  antigravityEnabled(): boolean {
    const s = this.get();
    return s.antigravity === true && ackIsCurrent(s.antigravityAck);
  }

  private findProvider(id: string): Provider | undefined {
    return this.data.providers?.find((p) => p.id === id);
  }

  /**
   * Providers, credential choices and preferences, for a settings export. Keys
   * stay the ciphertext they are, which only this machine and user account can
   * decrypt. The Antigravity opt-in isn't carried: it is acknowledged per install.
   */
  exportData(): SettingsExport {
    const { antigravity: _on, antigravityAck: _ack, ...settings } = this.get();
    return {
      kind: "unskilled-settings",
      version: 1,
      exportedAt: Date.now(),
      settings,
      providers: this.providers(),
      credentials: { ...(this.data.credentials ?? {}) },
    };
  }

  /**
   * Restore an export: its providers and credential choices replace ours, and
   * its preferences go through update()'s validation. A choice naming a
   * provider the export lacks falls back to the agent's own login. Legacy
   * secrets.* are left alone, so a downgrade still finds them.
   */
  importData(data: unknown): SettingsView {
    const x = data as Partial<SettingsExport> | null;
    if (!x || x.kind !== "unskilled-settings" || x.version !== 1) throw new Error("Not a CubiQ settings export.");
    const providers = (Array.isArray(x.providers) ? x.providers : []).filter(
      (p): p is Provider => Boolean(p && typeof p.id === "string" && typeof p.label === "string" && typeof p.baseURL === "string" && typeof p.wireProtocol === "string"),
    );
    const ids = new Set(providers.map((p) => p.id));
    const credentials: Record<string, CredentialChoice> = {};
    for (const [agentId, choice] of Object.entries(x.credentials ?? {})) {
      credentials[agentId] = choice?.kind === "byok" && ids.has(choice.providerId) ? { kind: "byok", providerId: choice.providerId } : { kind: "subscription" };
    }
    this.data.providers = providers;
    this.data.credentials = credentials;
    const { antigravity: _on, antigravityAck: _ack, ...prefs } = (x.settings ?? {}) as Partial<Settings>;
    this.update(prefs);
    return this.view();
  }

  providers(): Provider[] {
    return [...(this.data.providers ?? [])];
  }

  /** A Provider as the renderer sees it: the secret itself is replaced by its kind and whether it is usable. */
  providerView(p: Provider): ProviderView {
    const { secret, secretHeaders, ...rest } = p;
    return {
      ...rest,
      secretKind: secret.kind,
      hasSecret: this.secretIsUsable(secret),
      ...(secretHeaders && Object.keys(secretHeaders).length > 0 && { secretHeaderNames: Object.keys(secretHeaders) }),
    };
  }

  /**
   * Whether the secret still opens on this machine. safeStorage keys are scoped
   * to the app name and user account (renaming the app or a different account
   * makes decrypt throw), so a blob that can't be read reads as unset: listing
   * and the settings view must never fail over one.
   */
  private secretIsUsable(secret: ProviderSecret): boolean {
    if (secret.kind === "envRef") return Boolean(secret.envVar);
    if (secret.kind === "command") return Boolean(secret.command?.length);
    if (!secret.ciphertext) return false;
    try {
      this.box.decrypt(secret.ciphertext);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create or replace a provider. A duplicate id replaces every field including
   * wireProtocol, but keeps the stored ciphertext unless secretValue is given:
   * a string stores a new encrypted key, null clears it. Secret headers: the
   * ones `input.secretHeaderNames` lists are kept (all of them when it's
   * absent), and `headerValues` encrypts new or replaced ones.
   */
  saveProvider(input: ProviderInput, secretValue?: string | null, headerValues?: Record<string, string>): ProviderView {
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
    const { secretHeaderNames, ...fields } = input;
    const keep = new Set(secretHeaderNames ?? Object.keys(existing?.secretHeaders ?? {}));
    const secretHeaders: Record<string, string> = {};
    for (const [name, ciphertext] of Object.entries(existing?.secretHeaders ?? {})) if (keep.has(name)) secretHeaders[name] = ciphertext;
    for (const [name, value] of Object.entries(headerValues ?? {})) {
      if (name.trim() && value.trim()) secretHeaders[name.trim()] = this.box.encrypt(value.trim());
    }
    const provider: Provider = { ...fields, secret, ...(Object.keys(secretHeaders).length > 0 && { secretHeaders }) };
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

  /**
   * A provider the window hasn't saved (or is editing), ready to probe: its key
   * is the new value, else its env var, else the saved key of the same id (only
   * while the host is unchanged, so a typo'd or new URL never receives it); its
   * headers are fully resolved (kept secret headers decrypted, new ones added).
   */
  draftProvider(input: ProviderInput, secretValue?: string, headerValues: Record<string, string> = {}): { provider: Provider; key: string | null } {
    const { secretHeaderNames, secret: descriptor, ...fields } = input;
    const existing = this.findProvider(input.id);
    const sameHost = existing !== undefined && hostOf(existing.baseURL) !== null && hostOf(existing.baseURL) === hostOf(input.baseURL);
    const saved = sameHost ? this.providerSecretHeaders(input.id) : {};
    const keep = new Set(secretHeaderNames ?? Object.keys(saved));
    const secretHeaders = { ...Object.fromEntries(Object.entries(saved).filter(([name]) => keep.has(name))), ...headerValues };
    const provider: Provider = { ...fields, secret: { kind: "safeStorage" } };
    provider.headers = resolvedHeaders(headerPlan(provider, secretHeaders), process.env);
    const key = secretValue?.trim()
      ? secretValue.trim()
      : descriptor?.kind === "envRef" && descriptor.envVar
        ? (process.env[descriptor.envVar] ?? null)
        : sameHost
          ? this.providerSecret(input.id)
          : null;
    return { provider, key };
  }

  /** The provider's secret headers, decrypted; one that won't open on this machine is left out. */
  providerSecretHeaders(id: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, ciphertext] of Object.entries(this.findProvider(id)?.secretHeaders ?? {})) {
      try {
        out[name] = this.box.decrypt(ciphertext);
      } catch {
        // encrypted on another machine or user account
      }
    }
    return out;
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

  /** Every env var name a provider key may occupy, so editors don't inherit one. */
  secretEnvNames(): string[] {
    const names = new Set<string>(Object.values(LEGACY_ENV));
    for (const provider of this.providers()) for (const name of Object.keys(this.providerEnv(provider.id))) names.add(name);
    return [...names];
  }

  credential(agentId: string): CredentialChoice {
    // Providers are their own agents now, so every agent uses its own sign-in or config.
    return { kind: "subscription" };
  }
}

/** A URL's host, or null when it doesn't parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** A background model pick, or null when the value isn't one. */
function modelPick(value: unknown): { agent: string; model: string } | null {
  const v = value as { agent?: unknown; model?: unknown } | null;
  return v && typeof v.agent === "string" && v.agent && typeof v.model === "string" && v.model ? { agent: v.agent.slice(0, 200), model: v.model.slice(0, 200) } : null;
}

/** Self-improve settings with every field valid: off for any project not listed, each cap within 1k–5M. */
export function sanitizeLearn(value: Partial<LearnSettings> | undefined): LearnSettings {
  const v = value ?? {};
  const projects = Array.isArray(v.enabledProjects) ? v.enabledProjects.filter((s): s is string => typeof s === "string") : [];
  const clamp = (n: unknown, fallback: number): number => (typeof n === "number" && Number.isFinite(n) ? Math.round(Math.min(5_000_000, Math.max(1000, n))) : fallback);
  const cap = clamp(v.dailyTokens, LEARN_DEFAULTS.dailyTokens);
  const memoryCap = clamp(v.memoryDailyTokens, LEARN_DEFAULTS.memoryDailyTokens);
  const byProject: LearnSettings["backgroundByProject"] = {};
  if (v.backgroundByProject && typeof v.backgroundByProject === "object") {
    for (const [id, pick] of Object.entries(v.backgroundByProject).slice(0, 500)) {
      const p = modelPick(pick);
      if (p) byProject[id] = p;
    }
  }
  return { enabledProjects: [...new Set(projects)].slice(0, 500), dailyTokens: cap, memoryDailyTokens: memoryCap, background: modelPick(v.background), backgroundByProject: byProject };
}
