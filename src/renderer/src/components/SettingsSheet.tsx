import { useEffect, useRef, useState } from "react";
import type { Density, Motion, PermissionMode, SettingsView, Theme } from "../../../shared/types";
import { api } from "../api";
import { ProvidersSection } from "./ProviderSheet";
import { useStore, type LibraryTab } from "../store";
import { ANTIGRAVITY_ACK_VERSION } from "../../../shared/provider-rules";
import { UnsupportedChip } from "./UnsupportedChip";

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const MOTIONS: { id: Motion; label: string }[] = [
  { id: "instant", label: "Instant" },
  { id: "subtle", label: "Subtle" },
  { id: "full", label: "Full" },
];

const DENSITIES: { id: Density; label: string }[] = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
];

const MODES: { id: PermissionMode; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "auto-edit", label: "Auto-edit" },
  { id: "full", label: "Full" },
];

/** The left-nav groups, in order, and the sections each shows. */
export const SETTINGS_GROUPS = [
  { id: "appearance", label: "Appearance", sections: ["Appearance"] },
  { id: "threads", label: "Threads", sections: ["New threads", "Editor"] },
  { id: "agents", label: "Agents & Providers", sections: ["Providers", "Agents", "Antigravity"] },
  { id: "skills", label: "Skills & MCP", sections: ["Skills", "MCP servers"] },
  { id: "data", label: "Data & Security", sections: ["Data"] },
  { id: "updates", label: "Updates", sections: ["Updates"] },
] as const;

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]["id"];

/**
 * Where each section of the single scrolling sheet went. "Skills and agents"
 * lands in Skills & MCP; its agent list moved to Agents & Providers and its
 * data-folder button to Data & Security.
 */
export const FORMER_SECTIONS: Record<string, SettingsGroup> = {
  Appearance: "appearance",
  "New threads": "threads",
  Editor: "threads",
  Providers: "agents",
  Updates: "updates",
  "Skills and agents": "skills",
};

/** Settings, as a sheet over the window (⌘, / Ctrl+,): a left nav of groups, one group's sections at a time. */
export function SettingsSheet() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const [group, setGroup] = useState<SettingsGroup>("appearance");
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open || !settings) return null;

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="sheet settings-sheet" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} ref={panel}>
        <div className="sheet-head">
          <h2>Settings</h2>
          <button className="button ghost" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings groups">
            {SETTINGS_GROUPS.map((g) => (
              <button
                key={g.id}
                role="tab"
                id={`settings-tab-${g.id}`}
                aria-selected={group === g.id}
                aria-controls="settings-panel"
                className={group === g.id ? "on" : ""}
                onClick={() => setGroup(g.id)}
              >
                {g.label}
              </button>
            ))}
          </nav>
          <div className="settings-content" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${group}`}>
            <SettingsGroupContent group={group} settings={settings} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** One group's sections. */
export function SettingsGroupContent({ group, settings }: { group: SettingsGroup; settings: SettingsView }) {
  const agents = useStore((s) => s.agents);
  const skills = useStore((s) => s.skills);
  const appUpdate = useStore((s) => s.appUpdate);
  const editors = useStore((s) => s.editors);
  const update = (patch: Parameters<ReturnType<typeof api>["updateSettings"]>[0]) =>
    void api().updateSettings(patch).then((s) => useStore.setState({ settings: s }));
  const openLibrary = (tab: LibraryTab) => useStore.setState({ settingsOpen: false, libraryTab: tab });

  switch (group) {
    case "appearance":
      return (
        <section>
          <h3>Appearance</h3>
          <div className="row">
            <span className="label">Theme</span>
            <div className="segmented">
              {THEMES.map((t) => (
                <button key={t.id} className={settings.theme === t.id ? "on" : ""} onClick={() => update({ theme: t.id })}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <span className="label" title="Your system's reduce-motion setting always wins">Motion</span>
            <div className="segmented">
              {MOTIONS.map((m) => (
                <button key={m.id} className={(settings.motion ?? "instant") === m.id ? "on" : ""} onClick={() => update({ motion: m.id })}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <span className="label">Density</span>
            <div className="segmented">
              {DENSITIES.map((d) => (
                <button key={d.id} className={(settings.density ?? "comfortable") === d.id ? "on" : ""} onClick={() => update({ density: d.id })}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        </section>
      );
    case "threads":
      return (
        <>
          <section>
            <h3>New threads</h3>
            <div className="row">
              <span className="label">Agent</span>
              <select className="select" value={settings.defaultAgent ?? ""} onChange={(e) => update({ defaultAgent: e.target.value || null })}>
                <option value="">{agents[0]?.label ?? "Claude"} (default)</option>
                {agents.slice(1).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <span className="label">Permissions</span>
              <div className="segmented">
                {MODES.map((m) => (
                  <button key={m.id} className={settings.defaultPermissionMode === m.id ? "on" : ""} onClick={() => update({ defaultPermissionMode: m.id })}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section>
            <h3>Editor</h3>
            <div className="row">
              <span className="label">Open files in</span>
              {editors.length ? (
                <select className="select" value={settings.editor ?? ""} onChange={(e) => update({ editor: e.target.value || null })}>
                  <option value="">{editors[0]!.label} (first found)</option>
                  {editors.slice(1).map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="value">No editors found</span>
              )}
            </div>
            <p className="note">Used by Open in the Changes panel, the Files tab and file links in the conversation. Picking another editor there makes it the default.</p>
          </section>
        </>
      );
    case "agents":
      return (
        <>
          <ProvidersSection />
          <section>
            <h3>Agents</h3>
            <div className="row">
              <span className="label">Installed</span>
              <span className="value">{agents.map((a) => a.label).join(", ")}</span>
            </div>
            <p className="note">Add ACP agents in agents.json in the data folder (Data &amp; Security), then restart the app. The Library lists every agent it knows.</p>
          </section>
          <AntigravityOptIn settings={settings} update={update} />
        </>
      );
    case "skills":
      return (
        <>
          <section>
            <h3>Skills</h3>
            <div className="row">
              <span className="label">Skills</span>
              <span className="value">
                {skills.length > 0 ? `${skills.length} workflow skills in the / menu, and the rest loaded by the agent as needed` : "No skills installed"}
              </span>
            </div>
            <div className="row">
              <span className="label" />
              <button className="button" onClick={() => openLibrary("skills")}>
                Browse Skills…
              </button>
            </div>
          </section>
          <section>
            <h3>MCP servers</h3>
            <p className="note">Servers every agent gets, and the ones each agent brings from its own config, are in the Library.</p>
            <div className="row">
              <span className="label" />
              <button className="button" onClick={() => openLibrary("mcp")}>
                Open MCP Servers…
              </button>
            </div>
          </section>
        </>
      );
    case "data":
      return (
        <section>
          <h3>Data</h3>
          <div className="row">
            <span className="label">Keys</span>
            <span className="value">{settings.secretsEncrypted ? "Encrypted with your system keychain" : "Obfuscated: this system has no keychain"}</span>
          </div>
          <div className="row">
            <span className="label">Data folder</span>
            <button className="button" onClick={() => void api().openDataFolder()}>
              Open Data Folder
            </button>
          </div>
          <div className="row">
            <span className="label">Settings file</span>
            <button className="button" onClick={() => void api().exportSettings()}>
              Export Settings…
            </button>
            <button
              className="button"
              onClick={() =>
                void api()
                  .importSettings()
                  .then((s) => s && useStore.setState({ settings: s }))
                  .catch((err: unknown) => useStore.getState().showNotice(err instanceof Error ? err.message : String(err)))
              }
            >
              Import…
            </button>
          </div>
          <p className="note">
            An export holds your providers, which agent uses which, and these preferences. Keys go in it encrypted for this computer and user account only: on
            another machine, enter them again. Importing replaces your providers.
          </p>
          <p className="note">Threads, settings, agents.json and mcp.json live here. Export a thread from the command palette to keep or move it.</p>
        </section>
      );
    case "updates":
      return (
        <section>
          <h3>Updates</h3>
          <div className="row">
            <span className="label">Version</span>
            <span className="value">
              {appUpdate ? `UnSkilled ${appUpdate.current}` : "UnSkilled"}
              {appUpdate?.ready && ` · ${appUpdate.ready} is ready, and installs when you quit`}
            </span>
          </div>
          <div className="row">
            <span className="label">Auto-update</span>
            <div className="segmented">
              {[true, false].map((on) => (
                <button key={String(on)} className={settings.autoUpdate === on ? "on" : ""} onClick={() => update({ autoUpdate: on })}>
                  {on ? "On" : "Off"}
                </button>
              ))}
            </div>
          </div>
          {appUpdate && !appUpdate.supported && <p className="note">This build doesn't update itself. Installed releases do.</p>}
        </section>
      );
  }
}

/**
 * Antigravity runs Google's own ACP server, and its terms treat third-party
 * access as a breach: off by default, on only after the user acknowledges
 * that, and the acknowledgement is kept (with its disclosure version).
 */
export function AntigravityOptIn({ settings, update }: { settings: SettingsView; update(patch: Partial<SettingsView>): void }) {
  const [understood, setUnderstood] = useState(false);
  const acked = settings.antigravityAck?.version === ANTIGRAVITY_ACK_VERSION;
  const on = settings.antigravity === true && acked;
  return (
    <section>
      <h3>Antigravity</h3>
      <UnsupportedChip note="Gemini-compatible endpoints only" />
      <p className="note">
        UnSkilled runs Google's own Antigravity ACP server (agy_acp_server.par) with your own Google sign-in. The binary is Google's, but driving it from another
        app is still third-party access: the Antigravity Terms of Service (section 6) restrict that, and it isn't clear it's allowed, so it could put your account
        at risk. It can't use your OpenAI or Anthropic providers.
      </p>
      {on ? (
        <div className="row">
          <span className="label">Status</span>
          <span className="value">On{settings.antigravityAck ? ` since you accepted the risk on ${new Date(settings.antigravityAck.at).toLocaleDateString()}` : ""}. Restart to apply a change.</span>
          <button className="button" onClick={() => update({ antigravity: false })}>
            Turn Off
          </button>
        </div>
      ) : (
        <>
          <label className="row checkbox-row">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>I understand that using Antigravity here may breach its terms and put my account at risk.</span>
          </label>
          <div className="row">
            <span className="label" />
            <button
              className="button"
              disabled={!understood}
              onClick={() => update({ antigravityAck: { version: ANTIGRAVITY_ACK_VERSION, at: 0 }, antigravity: true })}
            >
              Turn On Antigravity
            </button>
          </div>
          <p className="note">Off by default. Turning it on adds Antigravity when the app restarts, if the ACP server (agy_acp_server.par) is on your PATH.</p>
        </>
      )}
    </section>
  );
}
