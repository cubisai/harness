import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PluginCommandInvocation, PluginCommandView, PluginConnector, PluginContributions, PluginOwner, PluginRuleTarget } from "../../shared/plugin-parts";
import type { SkillEntry } from "../../shared/types";
import type { AppDraft, StoredProposal } from "../extensions/manifest";
import type { ExtensionInstall, ExtensionStore, InstalledFile } from "../extensions/store";
import { assertContained, verifyInstalledFiles } from "../extensions/install";
import { AutomationStore } from "../automations/store";
import { automationDigest } from "../creator/automations";
import { validateApp } from "./manifest";
import { contributionViews, decidePluginRule, partRuntimeName } from "./parts";
import type { AppRegistry } from "./registry";
import { parseSkillMd } from "../skills/discover";
import { appThemeHash, parseAppTheme } from "./app-theme-validation";
import type { AppThemeView } from "../../shared/app-themes";

interface OwnedAutomation { name: string; id: string; hash: string }
interface BundleRow { key: string; install_id: string; parts: string; project_id: string | null; revision: string; automations: string }
interface Operation { folder: string; previous: ExtensionInstall | null; files: InstalledFile[]; remove: boolean }
export interface BundleDeps {
  db: DatabaseSync;
  extensions: ExtensionStore;
  registry: Pick<AppRegistry, "isEnabled" | "setEnabled"> & Partial<Pick<AppRegistry, "info">>;
  dir: string;
  projectExists(id: string): boolean;
  authoringProject(threadId: string): string | null;
  checkAgent(input: import("../../shared/automations").AutomationInput): void;
  changed(key: string, removed: boolean): void;
  interrupt(threadId: string): void;
  /** Fail closed while a build's remaining review/permission transports are not ready. */
  deliveryReady?(): boolean;
  /** Committed Update/Uninstall only; failures retain the operation journal for startup retry. */
  cleanupConnectorCredentials?(key: string, keep: PluginConnector[]): void;
}
const hash = (v: string) => createHash("sha256").update(v).digest("hex");

/** Only reviewed snapshots register non-UI capabilities. Files and SQLite commit via a durable journal. */
export class PluginBundles {
  private ready = false;
  private automations: AutomationStore;
  constructor(private deps: BundleDeps) { this.automations = new AutomationStore(deps.db); }

  private row(key: string): BundleRow | null {
    return this.deps.db.prepare("SELECT * FROM plugin_bundles WHERE key = ?").get(key) as unknown as BundleRow ?? null;
  }
  owns(key: string): boolean { return Boolean(this.row(key)); }
  private pending(key: string): boolean { return Boolean(this.deps.db.prepare("SELECT 1 FROM plugin_bundle_ops WHERE key = ?").get(key)); }
  error(key: string): string | null {
    if (this.pending(key)) return "This bundle needs recovery. Its parts are unavailable; its recovery files were kept.";
    const row = this.row(key);
    if (!row) return null;
    const install = this.deps.extensions.getInstall(row.install_id);
    try {
      if (!install || install.kind !== "app" || install.location !== join(this.deps.dir, install.name)) throw new Error("Missing bundle ownership record.");
      assertContained(this.deps.dir, install.location, "bundle");
      verifyInstalledFiles(install.location, install.files, install.name, true);
      return null;
    } catch (e) { return `Bundle unavailable: ${(e as Error).message}`; }
  }
  runtimeError(key: string): string | null {
    const error = this.error(key);
    if (error || !this.owns(key)) return error;
    if (!this.ready) return "This bundle needs recovery before it can run.";
    if (this.deps.deliveryReady?.() === false) return "Plugin bundles are unavailable in this build while permission and review support is being completed.";
    return null;
  }
  available(key: string): boolean { return this.ready && this.deps.deliveryReady?.() !== false && this.owns(key) && this.deps.registry.isEnabled(key) && !this.error(key); }
  parts(key: string) {
    const row = this.row(key);
    return row ? contributionViews(key.slice(2), JSON.parse(row.parts) as PluginContributions, row.project_id ?? undefined) : [];
  }
  private rows(): BundleRow[] { return this.deps.db.prepare("SELECT * FROM plugin_bundles ORDER BY key").all() as unknown as BundleRow[]; }
  rules(target: PluginRuleTarget, readOnly: boolean): "ask" | "allow" | null {
    const rules = this.rows().filter((r) => this.available(r.key)).flatMap((r) => (JSON.parse(r.parts) as PluginContributions).rules ?? []);
    return decidePluginRule(rules, target, readOnly);
  }
  /** Pins a request to the current active policies while it waits for a single-use approval. */
  rulesRevision(): string {
    return hash(JSON.stringify(this.rows().filter((r) => this.available(r.key) && (JSON.parse(r.parts) as PluginContributions).rules?.length).map((r) => [r.key, r.revision])));
  }
  commands(): PluginCommandView[] {
    return this.rows().filter((r) => this.available(r.key)).flatMap((r) => ((JSON.parse(r.parts) as PluginContributions).commands ?? []).map((c) => ({ key: r.key, name: c.name, revision: r.revision, command: `${r.key.slice(2)}.${c.name}`, description: c.description })));
  }
  command(invocation: PluginCommandInvocation): { prompt: string; skill: string } {
    const row = this.row(invocation.key);
    const part = row && (JSON.parse(row.parts) as PluginContributions).commands?.find((c) => c.name === invocation.name);
    if (!row || !part || row.revision !== invocation.revision || !this.available(row.key)) throw new Error("This plugin command is Off, removed or changed. Pick its current command again.");
    return { prompt: part.prompt, skill: `${row.key.slice(2)}.${part.name}` };
  }
  skills(includeOff = false): SkillEntry[] {
    return this.rows().filter((r) => includeOff || this.available(r.key)).flatMap((r) => ((JSON.parse(r.parts) as PluginContributions).skills ?? []).map((s): SkillEntry => {
      const name = partRuntimeName(r.key.slice(2), s.name), dir = join(this.deps.dir, r.key.slice(2), ...s.path.split("/"));
      const owner = this.owner(r.key)!;
      // Read only a verified snapshot. An unavailable bundle stays identifiable in Library.
      const verified = !this.error(r.key);
      const text = verified ? readFileSync(join(dir, "SKILL.md"), "utf8") : "";
      const parsed = parseSkillMd(text);
      return { name, description: s.description, invocation: parsed.disableModelInvocation ? "user" : "model", calls: [], files: [], sha256: hash(text), origin: "plugin", dir, userInvocable: verified && parsed.userInvocable, ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}), ...(parsed.mode ? { mode: parsed.mode } : {}), enabled: owner.enabled, owner };
    }));
  }
  assertSkill(skill: SkillEntry): void {
    if (skill.origin !== "plugin") return;
    const row = skill.owner && this.row(skill.owner.key);
    const part = row && (JSON.parse(row.parts) as PluginContributions).skills?.find((s) => partRuntimeName(row.key.slice(2), s.name) === skill.name);
    if (!row || !part || row.revision !== skill.owner?.revision || !this.available(row.key) || skill.dir !== join(this.deps.dir, row.key.slice(2), ...part.path.split("/"))) throw new Error("This plugin skill is Off, removed or changed. Pick its current skill again.");
  }
  connectors(includeOff = false) {
    return this.rows().filter((r) => includeOff || this.available(r.key)).flatMap((r) => ((JSON.parse(r.parts) as PluginContributions).connectors ?? []).map((c) => ({ ...c, runtimeName: partRuntimeName(r.key.slice(2), c.name), owner: this.owner(r.key)!, revision: r.revision })));
  }
  themes(): AppThemeView[] {
    return this.rows().flatMap((row) => {
      try {
        const raw = (JSON.parse(row.parts) as PluginContributions).appTheme;
        if (!raw) return [];
        const theme = parseAppTheme(raw)!;
        const error = this.runtimeError(row.key) ?? (!this.deps.registry.isEnabled(row.key) ? "The owning plugin is Off." : undefined);
        return [{ key: row.key, revision: row.revision, hash: appThemeHash(theme), title: this.deps.registry.info?.(row.key)?.title ?? row.key.slice(2), enabled: this.available(row.key), ...(error ? { error } : {}), theme }];
      } catch { return []; } // Unvalidated persisted data never becomes a palette.
    });
  }
  assertConnector(connector: ReturnType<PluginBundles["connectors"]>[number]): void {
    const row = this.row(connector.owner.key);
    const part = row && (JSON.parse(row.parts) as PluginContributions).connectors?.find((c) => c.name === connector.name);
    if (!row || !part || row.revision !== connector.revision || !this.available(row.key) || connector.runtimeName !== partRuntimeName(row.key.slice(2), part.name) || JSON.stringify(part.spec) !== JSON.stringify(connector.spec)) throw new Error("This plugin connector is Off, removed or changed. Start a new thread to use its current connector.");
  }
  owner(key: string): PluginOwner | null {
    const row = this.row(key);
    return row ? { key, title: key.slice(2), enabled: this.available(key), revision: row.revision } : null;
  }
  automationOwner(id: string): PluginOwner | null {
    const row = this.rows().find((r) => (JSON.parse(r.automations) as OwnedAutomation[]).some((a) => a.id === id));
    return row ? this.owner(row.key) : null;
  }
  automationAllowed(id: string): boolean { const owner = this.automationOwner(id); return this.ready && (!owner || owner.enabled); }
  private ownedAutomations(row: BundleRow): OwnedAutomation[] { return JSON.parse(row.automations) as OwnedAutomation[]; }
  private preflight(row: BundleRow | null): void {
    if (!row) return;
    for (const owned of this.ownedAutomations(row)) {
      const a = this.automations.get(owned.id);
      if (!a || automationDigest(a) !== owned.hash) throw new Error(`Bundled automation "${owned.name}" was modified or removed; its settings were kept.`);
      if (this.deps.db.prepare("SELECT 1 FROM automation_runs WHERE automation_id = ? AND status IN ('queued', 'running', 'waiting-input')").get(a.id)) throw new Error("A bundled automation has active work. Wait for it before Update or Uninstall.");
    }
  }
  setEnabled(key: string, on: boolean): void {
    if (on && this.error(key)) throw new Error(this.error(key)!);
    this.deps.registry.setEnabled(key, on);
    this.deps.db.prepare("UPDATE plugin_bundles SET revision = ? WHERE key = ?").run(randomUUID(), key);
    if (!on) for (const owned of this.ownedAutomations(this.row(key) ?? { automations: "[]" } as BundleRow)) {
      for (const run of this.automations.runs(owned.id, 10_000)) if (["queued", "running", "waiting-input"].includes(run.status)) {
        if (run.threadId) this.deps.interrupt(run.threadId);
        this.automations.finishRun(run.id, { status: "cancelled", error: "The owning plugin was turned off." });
      }
    }
    try { this.deps.changed(key, false); } catch { /* State is already saved. */ }
  }

  install(proposal: StoredProposal, draft: AppDraft, digest: string): void {
    if (!this.ready) throw new Error("Plugin bundle recovery is still in progress.");
    const checked = validateApp(draft.name, draft.files);
    if (!checked.ok) throw new Error(checked.errors.join("\n"));
    const parts = checked.manifest.contributes ?? {};
    const key = `g~${draft.name}`, dest = join(this.deps.dir, draft.name);
    const old = this.row(key);
    if (this.pending(key)) throw new Error(this.error(key)!);
    this.preflight(old);
    const previous = this.deps.extensions.installs({ kind: "global" }).find((i) => i.kind === "app" && i.name === draft.name) ?? null;
    if ((previous && previous.location !== dest) || (old && old.install_id !== previous?.id)) throw new Error("Bundle ownership does not match its destination.");
    mkdirSync(this.deps.dir, { recursive: true });
    assertContained(this.deps.dir, dest, "bundle destination");
    if (existsSync(dest)) {
      if (!previous) throw new Error("This app folder is not owned by CubiQ.");
      verifyInstalledFiles(dest, previous.files, draft.name, true);
    } else if (previous) throw new Error("The installed app folder was removed; use a fresh name.");
    if (parts.automations?.length && (!draft.bundleProjectId || !this.deps.projectExists(draft.bundleProjectId) || this.deps.authoringProject(proposal.threadId) !== draft.bundleProjectId)) throw new Error("Bundled automations must belong to this Creator thread's existing project.");
    if (old?.project_id && parts.automations?.length && old.project_id !== draft.bundleProjectId) throw new Error("Update cannot move bundled automations to another project.");
    for (const a of parts.automations ?? []) {
      this.deps.checkAgent(a.input);
      const ownedId = old && this.ownedAutomations(old).find((o) => o.name === a.name)?.id;
      if (this.automations.list(draft.bundleProjectId).some((existing) => existing.id !== ownedId && existing.name.trim().toLowerCase() === a.input.name.toLowerCase())) throw new Error("An automation with this title already exists in the project.");
    }
    const folder = join(this.deps.dir, ".bundle-recovery", randomUUID());
    assertContained(this.deps.dir, folder, "bundle recovery");
    mkdirSync(join(folder, "new"), { recursive: true });
    const files = draft.files.map((f) => ({ path: f.path, sha256: hash(f.content) }));
    for (const f of draft.files) {
      const path = join(folder, "new", ...f.path.split("/"));
      assertContained(join(folder, "new"), path, f.path);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, f.content);
    }
    const operation: Operation = { folder, previous, files, remove: false };
    this.deps.db.prepare("INSERT INTO plugin_bundle_ops (key, operation) VALUES (?, ?)").run(key, JSON.stringify(operation));
    let committed = false;
    try {
      if (previous) renameSync(dest, join(folder, "old"));
      renameSync(join(folder, "new"), dest);
      this.deps.extensions.transaction(() => {
        const owned: OwnedAutomation[] = [];
        for (const part of parts.automations ?? []) {
          const id = (old && this.ownedAutomations(old).find((a) => a.name === part.name)?.id) || randomUUID();
          const saved = this.automations.get(id) ? this.automations.update(id, part.input) : this.automations.create({ ...part.input, id, projectId: draft.bundleProjectId!, anchor: Date.now() });
          owned.push({ name: part.name, id, hash: automationDigest(saved) });
        }
        if (old) for (const a of this.ownedAutomations(old)) if (!owned.some((n) => n.id === a.id)) this.automations.remove(a.id);
        const install = this.deps.extensions.recordInstall({ proposalId: proposal.id, scope: { kind: "global" }, kind: "app", name: draft.name, location: dest, files, digest });
        this.deps.db.prepare("INSERT OR REPLACE INTO plugin_bundles (key, install_id, parts, project_id, revision, automations) VALUES (?, ?, ?, ?, ?, ?)").run(key, install.id, JSON.stringify(parts), draft.bundleProjectId ?? null, randomUUID(), JSON.stringify(owned));
        this.deps.extensions.setStatus(proposal.id, "installed");
        this.deps.db.prepare("UPDATE plugin_bundle_ops SET committed = 1 WHERE key = ?").run(key);
      });
      committed = true;
      try { this.finish(key, operation, true); }
      catch (e) { this.deps.db.prepare("UPDATE plugin_bundle_ops SET error = ? WHERE key = ?").run((e as Error).message, key); }
    } catch (e) {
      if (!committed) try { this.finish(key, operation, false); }
      catch (recovery) { this.deps.db.prepare("UPDATE plugin_bundle_ops SET error = ? WHERE key = ?").run((recovery as Error).message, key); }
      throw e;
    }
    try { this.deps.changed(key, false); } catch { /* Committed state is independent of notifications. */ }
  }

  uninstall(install: ExtensionInstall): void {
    const key = `g~${install.name}`, row = this.row(key);
    if (!row || row.install_id !== install.id || this.pending(key)) throw new Error("Bundle ownership is unavailable.");
    if (install.location !== join(this.deps.dir, install.name)) throw new Error("Bundle ownership does not match its destination.");
    this.preflight(row);
    assertContained(this.deps.dir, install.location, "bundle destination");
    verifyInstalledFiles(install.location, install.files, install.name, true);
    const folder = join(this.deps.dir, ".bundle-recovery", randomUUID());
    mkdirSync(folder, { recursive: true });
    assertContained(this.deps.dir, folder, "bundle recovery");
    const operation: Operation = { folder, previous: install, files: [], remove: true };
    this.deps.db.prepare("INSERT INTO plugin_bundle_ops (key, operation) VALUES (?, ?)").run(key, JSON.stringify(operation));
    let committed = false;
    try {
      renameSync(install.location, join(folder, "old"));
      this.deps.extensions.transaction(() => {
        for (const a of this.ownedAutomations(row)) this.automations.remove(a.id);
        this.deps.db.prepare("DELETE FROM plugin_bundles WHERE key = ?").run(key);
        this.deps.extensions.removeInstall(install.id);
        this.deps.db.prepare("UPDATE plugin_bundle_ops SET committed = 1 WHERE key = ?").run(key);
      });
      committed = true;
      try { this.finish(key, operation, true); }
      catch (e) { this.deps.db.prepare("UPDATE plugin_bundle_ops SET error = ? WHERE key = ?").run((e as Error).message, key); }
    } catch (e) {
      if (!committed) try { this.finish(key, operation, false); }
      catch (recovery) { this.deps.db.prepare("UPDATE plugin_bundle_ops SET error = ? WHERE key = ?").run((recovery as Error).message, key); }
      throw e;
    }
    try { this.deps.changed(key, true); } catch { /* Committed state is independent of notifications. */ }
  }

  private finish(key: string, op: Operation, committed: boolean): void {
    if (!/^g~[a-z0-9][a-z0-9-]{0,63}$/.test(key)) throw new Error("Invalid journal owner.");
    const name = key.slice(2), dest = join(this.deps.dir, name), stage = join(op.folder, "new"), old = join(op.folder, "old");
    if (dirname(op.folder) !== join(this.deps.dir, ".bundle-recovery") || !/^[A-Za-z0-9-]+$/.test(basename(op.folder)) || typeof op.remove !== "boolean" || !Array.isArray(op.files) || (op.previous && (op.previous.kind !== "app" || op.previous.name !== name || op.previous.location !== dest))) throw new Error("Invalid operation journal; recovery files were kept.");
    assertContained(join(this.deps.dir, ".bundle-recovery"), op.folder, "operation journal");
    assertContained(this.deps.dir, dest, "bundle");
    if (committed) {
      if (!op.remove) verifyInstalledFiles(dest, op.files, name, true);
      else if (existsSync(dest)) throw new Error("An unowned folder appeared during removal; recovery files were kept.");
      const row = this.row(key);
      this.deps.cleanupConnectorCredentials?.(key, row ? (JSON.parse(row.parts) as PluginContributions).connectors ?? [] : []);
      if (existsSync(old)) { verifyInstalledFiles(old, op.previous?.files ?? [], name, true); rmSync(old, { recursive: true }); }
    } else {
      // While the staged copy still exists, the destination is either the untouched old app or absent.
      // Only a promoted new copy (stage no longer exists) may be removed during rollback.
      if (!op.remove && !existsSync(stage) && existsSync(dest) && (!op.previous || existsSync(old))) { verifyInstalledFiles(dest, op.files, name, true); rmSync(dest, { recursive: true }); }
      if (existsSync(old)) { verifyInstalledFiles(old, op.previous?.files ?? [], name, true); if (existsSync(dest)) throw new Error("Recovery destination is occupied."); renameSync(old, dest); }
      else if (op.previous) verifyInstalledFiles(dest, op.previous.files, name, true);
    }
    if (existsSync(stage)) { verifyInstalledFiles(stage, op.files, name, true); rmSync(stage, { recursive: true }); }
    // An unexpected file beside old/new is not ours. Keep it (and the journal) for recovery.
    rmdirSync(op.folder);
    this.deps.db.prepare("DELETE FROM plugin_bundle_ops WHERE key = ?").run(key);
  }
  recover(): void {
    const rows = this.deps.db.prepare("SELECT key, operation, committed FROM plugin_bundle_ops").all() as unknown as { key: string; operation: string; committed: number }[];
    for (const r of rows) try { this.finish(r.key, JSON.parse(r.operation) as Operation, Boolean(r.committed)); }
    catch (e) { this.deps.db.prepare("UPDATE plugin_bundle_ops SET error = ? WHERE key = ?").run((e as Error).message, r.key); }
    this.ready = true;
  }
}
