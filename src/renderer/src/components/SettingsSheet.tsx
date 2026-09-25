import { useEffect, useRef, useState } from "react";
import type { PermissionMode, SecretName, Theme } from "../../../shared/types";
import { api } from "../api";
import { useStore } from "../store";

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const MODES: { id: PermissionMode; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "auto-edit", label: "Auto-edit" },
  { id: "full", label: "Full" },
];

const KEYS: { id: SecretName; label: string; hint: string; placeholder: string }[] = [
  { id: "anthropic", label: "Anthropic", hint: "For Claude, if you don't use a Claude Code login.", placeholder: "sk-ant-…" },
  { id: "deepseek", label: "DeepSeek", hint: "For DeepSeek (dsh).", placeholder: "sk-…" },
  { id: "openai", label: "OpenAI", hint: "For Codex, if you don't use a Codex login.", placeholder: "sk-…" },
];

/** Settings, as a sheet over the window (⌘, / Ctrl+,). */
export function SettingsSheet() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  const agents = useStore((s) => s.agents);
  const skills = useStore((s) => s.skills);
  const appUpdate = useStore((s) => s.appUpdate);
  const editors = useStore((s) => s.editors);
  const setOpen = useStore((s) => s.setSettingsOpen);
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
  const update = (patch: Parameters<ReturnType<typeof api>["updateSettings"]>[0]) =>
    void api().updateSettings(patch).then((s) => useStore.setState({ settings: s }));

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} ref={panel}>
        <div className="sheet-head">
          <h2>Settings</h2>
          <button className="button ghost" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>

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
        </section>

        <section>
          <h3>New threads</h3>
          <div className="row">
            <span className="label">Agent</span>
            <select
              className="select"
              value={settings.defaultAgent ?? ""}
              onChange={(e) => update({ defaultAgent: e.target.value || null })}
            >
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
          <p className="note">Used by Open in the Changes panel and by file links in the conversation. Picking another editor there makes it the default.</p>
        </section>

        <section>
          <h3>API keys</h3>
          <p className="note">
            {settings.secretsEncrypted
              ? "Stored encrypted with your system keychain, and only ever passed to the agent they belong to."
              : "This system has no keychain available, so keys are stored obfuscated, not encrypted."}{" "}
            Saving or removing a key restarts running agents.
          </p>
          {KEYS.map((k) => (
            <SecretRow key={k.id} {...k} isSet={settings.secretsSet[k.id]} />
          ))}
        </section>

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

        <section>
          <h3>Skills and agents</h3>
          <div className="row">
            <span className="label">Skills</span>
            <span className="value">
              {skills.length > 0
                ? `${skills.length} workflow skills in the / menu, and the rest loaded by the agent as needed`
                : "No skills installed"}
            </span>
          </div>
          <div className="row">
            <span className="label">Agents</span>
            <span className="value">{agents.map((a) => a.label).join(", ")}</span>
          </div>
          <div className="row">
            <span className="label" />
            <button className="button" onClick={() => void api().openDataFolder()}>
              Open Data Folder
            </button>
          </div>
          <p className="note">Add ACP agents in agents.json in the data folder, then restart the app.</p>
        </section>
      </div>
    </div>
  );
}

function SecretRow({ id, label, hint, placeholder, isSet }: { id: SecretName; label: string; hint: string; placeholder: string; isSet: boolean }) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(!isSet);
  useEffect(() => setEditing(!isSet), [isSet]);
  const save = (v: string | null) =>
    void api()
      .setSecret(id, v)
      .then((s) => {
        useStore.setState({ settings: s });
        setValue("");
      });

  return (
    <div className="row secret">
      <span className="label" title={hint}>
        {label}
      </span>
      {editing ? (
        <form
          className="secret-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) save(value);
          }}
        >
          <input
            className="text-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button className="button" type="submit" disabled={!value.trim()}>
            Save
          </button>
          {isSet && (
            <button className="button ghost" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="secret-form">
          <span className="value">
            <span className="dot-ok" /> Saved
          </span>
          <button className="button ghost" onClick={() => setEditing(true)}>
            Replace
          </button>
          <button className="button ghost danger" onClick={() => save(null)}>
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
