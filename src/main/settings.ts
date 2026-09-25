import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PermissionMode, SecretName, Settings, SettingsView } from "../shared/types";

/** Encrypts secrets at rest. In the app this is Electron's safeStorage (the OS keychain). */
export interface SecretBox {
  available: boolean;
  encrypt(plain: string): string; // base64
  decrypt(b64: string): string;
}

/** Which environment variable each stored key becomes for agent processes. */
export const SECRET_ENV: Record<SecretName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
};

const DEFAULTS: Settings = { theme: "system", defaultAgent: null, defaultPermissionMode: "ask", autoUpdate: true, editor: null };

interface FileShape {
  settings?: Partial<Settings>;
  secrets?: Partial<Record<SecretName, string>>; // encrypted, base64
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

  get(): Settings {
    return { ...DEFAULTS, ...this.data.settings };
  }

  view(): SettingsView {
    const secrets = this.data.secrets ?? {};
    return {
      ...this.get(),
      secretsSet: { anthropic: Boolean(secrets.anthropic), deepseek: Boolean(secrets.deepseek), openai: Boolean(secrets.openai) },
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
    this.data.settings = next;
    this.write();
    return next;
  }

  setSecret(name: SecretName, value: string | null): void {
    const secrets = { ...this.data.secrets };
    const trimmed = value?.trim();
    if (trimmed) secrets[name] = this.box.encrypt(trimmed);
    else delete secrets[name];
    this.data.secrets = secrets;
    this.write();
  }

  secret(name: SecretName): string | null {
    const stored = this.data.secrets?.[name];
    if (!stored) return null;
    try {
      return this.box.decrypt(stored);
    } catch {
      return null; // encrypted on another machine or user account
    }
  }

  /**
   * Stored keys as environment variables for agent processes. A key set in
   * the app wins over the same variable inherited from the shell.
   */
  env(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, envVar] of Object.entries(SECRET_ENV) as [SecretName, string][]) {
      const value = this.secret(name);
      if (value) out[envVar] = value;
    }
    return out;
  }
}
